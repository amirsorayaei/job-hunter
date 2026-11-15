/**
 * Prep agent: tailors the resume (and writes the email) for roles queued in
 * the app, automatically for high scores or by the owner's "Prepare" button.
 *
 *   pnpm agent:prep            prepare everything queued (at most 6 per run)
 *   pnpm agent:prep --once     prepare at most one
 *
 * Exactly the Mac workflow (the tailoring kit, 2026-11-15): Claude runs inside
 * the resume workspace, so its CLAUDE.md is the rulebook, and does the Fit
 * check and the Tailoring workflow itself: it tailors a fresh copy of the
 * frozen baseline from the evidence ledger, renders the PDF with
 * tools/generate_pdf.py and verifies it is one page. This script only:
 * 1. scaffolds applications/<slug>/ with the baseline and the JD,
 * 2. runs that Claude session with a narrow allowlist,
 * 3. re-checks the PDF (one page, header email and location, no Iran),
 * 4. verifies any recipient address, records the role in job-search-history,
 *    and uploads PDF + email. The app makes the Gmail draft; nothing is sent.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { emailsIn, isIndiaRole } from "../../src/lib/agent/filter";
import { completePrep, domainAcceptsMail, emptyDir, pageText, prompt, rpc, runAgent, runClaude, WORKSPACE } from "./lib";

const PYTHON = join(WORKSPACE, ".venv", "bin", "python");
const MAX_PER_RUN = 6;
const HEADER_EMAIL = "you@example.com";

const jobSchema = z.object({
  roleId: z.string(),
  track: z.enum(["frontend", "fullstack"]),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  applyKind: z.enum(["email", "form"]),
  applyEmail: z.string().optional(),
  remoteWording: z.string(),
  whyFit: z.string(),
  gaps: z.string(),
  mustHaves: z.array(z.string()),
});
type Job = z.infer<typeof jobSchema>;

const resultSchema = z.object({
  fit: z.enum(["good", "workable", "not_a_fit"]),
  reason: z.string(),
  title: z.string(),
  keywordsMatched: z.array(z.string()),
  missing: z.array(z.string()),
  changes: z.array(z.string()),
  notes: z.string(),
  recipient: z.string().nullable(),
  email: z.object({ subject: z.string(), body: z.string() }).nullable(),
});

const RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fit", "reason", "title", "keywordsMatched", "missing", "changes", "notes", "recipient", "email"],
  properties: {
    fit: { type: "string", enum: ["good", "workable", "not_a_fit"] },
    reason: { type: "string", description: "The fit verdict in one to three sentences: matched requirements, caveats, dealbreakers" },
    title: { type: "string", description: "The resume title used (empty when not a fit)" },
    keywordsMatched: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" }, description: "Required JD skills he lacks (not claimed)" },
    changes: { type: "array", items: { type: "string" }, description: "What was changed versus the baseline, one item per change" },
    notes: { type: "string", description: "Anything Candidate should know; empty if nothing" },
    recipient: { anyOf: [{ type: "null" }, { type: "string" }] },
    email: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["subject", "body"],
          properties: { subject: { type: "string" }, body: { type: "string" } },
        },
      ],
    },
  },
};

const gateSchema = z.object({ verdict: z.enum(["stop", "proceed"]), reason: z.string() });
const GATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: { verdict: { type: "string", enum: ["stop", "proceed"] }, reason: { type: "string" } },
};

/** One command that renders the PDF and prints its page count and text (CLAUDE.md steps 5-6). */
const RENDER_CHECK = join(WORKSPACE, "job-hunter", "scripts", "agent", "render-check.sh");

function slugFor(job: Job): string {
  const raw = `${job.company}-${job.title}`
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return raw.slice(0, 60).replace(/-+$/, "");
}

/** Readable text from a job page's HTML (fallback copy of the JD for the README and the prompt). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function pdfPages(pdf: string): number {
  const info = spawnSync("pdfinfo", [pdf], { encoding: "utf8" });
  return Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1] ?? "0");
}

/** The address must appear on the cited page (or the posting) and its domain must take mail. */
async function verifyRecipient(address: string, sources: string[], log: (m: string) => void): Promise<string | undefined> {
  const wanted = address.trim().toLowerCase();
  if (!(await domainAcceptsMail(wanted))) {
    log(`  recipient ${wanted} dropped: domain does not accept mail`);
    return undefined;
  }
  for (const source of sources) {
    try {
      if (emailsIn(await pageText(source)).includes(wanted)) return source;
    } catch {
      // try the next source
    }
  }
  log(`  recipient ${wanted} dropped: not found on ${sources.join(" or ")}`);
  return undefined;
}

/** Addresses on the page that look like an application inbox. */
function candidateRecipients(text: string): string[] {
  return emailsIn(text).filter((address) => !/^(noreply|no-reply|privacy|legal|abuse|press|security|dpo|arb|support|billing)/i.test(address));
}

/** Hard checks on the finished PDF, whatever the session said. */
function checkPdf(pdf: string): string | undefined {
  if (!existsSync(pdf)) return "no PDF was produced";
  const pages = pdfPages(pdf);
  if (pages !== 1) return `the PDF is ${pages} pages, not 1`;
  const text = spawnSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" }).stdout;
  if (/\biran\b/i.test(text)) return "the PDF mentions Iran";
  if (!text.includes(HEADER_EMAIL)) return `the header email is not ${HEADER_EMAIL}`;
  if (!/Your City, Country/.test(text)) return "the header location is not Your City, Country";
  return undefined;
}

function recordHistory(job: Job, status: "prepared" | "skipped", notes: string): void {
  spawnSync("python3", [join(WORKSPACE, "tools", "history.py"), "add", "--company", job.company, "--role", job.title, "--url", job.url, "--status", status, "--notes", notes.slice(0, 300)], {
    cwd: WORKSPACE,
    encoding: "utf8",
  });
}

async function prepare(job: Job, log: (m: string) => void, model: string): Promise<string> {
  // Roles queued before the India rule existed: drop them before spending tokens.
  if (isIndiaRole(job)) throw new NotAFit("India role (excluded by the owner's rule).");

  const slug = slugFor(job);
  const appRel = `applications/${slug}`;
  const appDir = join(WORKSPACE, appRel);
  const companySlug = job.company.replace(/\(.*?\)/g, "").replace(/[^A-Za-z0-9]+/g, "") || "Company";
  const filename = `YourName-Resume-${companySlug}.pdf`;
  const pdf = join(appDir, filename);
  log(`prepare ${job.company} · ${job.title} → ${appRel}`);

  // Scaffold (CLAUDE.md steps 2 and 4): a FRESH copy of the track's frozen baseline, never an older tailoring.
  mkdirSync(appDir, { recursive: true });
  copyFileSync(join(WORKSPACE, "resume-source", job.track, "resume_content.py"), join(appDir, "resume_content.py"));
  rmSync(pdf, { force: true });

  let html = "";
  try {
    html = await pageText(job.url);
  } catch {
    html = "";
  }
  const jd = htmlToText(html).slice(0, 14_000);
  writeFileSync(
    join(appDir, "README.md"),
    [
      `# ${slug}`,
      "",
      `- **Company:** ${job.company}`,
      `- **Role:** ${job.title}`,
      `- **Link:** ${job.url}`,
      "- **Status:** prepared",
      "",
      "## Job description (page text at prep time)",
      jd === "" ? "(not captured; read from the link)" : jd,
      "",
    ].join("\n"),
  );

  const candidates = [...new Set([...(job.applyEmail !== undefined ? [job.applyEmail.toLowerCase()] : []), ...candidateRecipients(html)])];
  const recipientRule =
    candidates.length > 0
      ? `set \`recipient\` to one of these addresses, found on the posting: ${candidates.join(", ")}, the one that takes applications (null if none of them does). Never any other address.`
      : "`recipient` and `email` are always null: no application address was found, he applies through the form.";

  const role = [
    `- Company: ${job.company}`,
    `- Title: ${job.title}`,
    `- Posting: ${job.url}`,
    `- Track (which baseline): ${job.track}`,
    `- Employer's location wording: ${job.remoteWording}`,
    `- The screener's view, to verify against the JD: why it fits: ${job.whyFit} Gaps: ${job.gaps}`,
    `- Must-haves noted: ${job.mustHaves.join(", ")}`,
  ].join("\n");

  // 1. A quick, tool-less gate: stop early only on a clear, quoted dealbreaker.
  //    Skipped when the page text could not be read (the full session fetches it).
  if (jd.length >= 1500) {
    const gate = await runClaude({
      prompt: prompt("prep-fit", { PROFILE: prompt("profile"), ROLE: role, JD: jd }),
      allow: [],
      cwd: emptyDir(),
      schema: GATE_JSON_SCHEMA,
      model,
      effort: "low",
      timeoutMin: 5,
      log,
    });
    const verdict = gateSchema.safeParse(gate.structured);
    if (verdict.success && verdict.data.verdict === "stop") {
      recordHistory(job, "skipped", `Not a fit (quick check): ${verdict.data.reason}`);
      throw new NotAFit(verdict.data.reason);
    }
  }

  // 2. The full Mac-style session. Everything it needs is in the prompt, so it
  //    spends its steps on writing, not on reading files (each step re-reads the whole context).
  const read = (rel: string) => readFileSync(join(WORKSPACE, rel), "utf8");
  const example = "applications/tether-frontend-engineer/application-answers.md";
  const run = await runClaude({
    prompt: prompt("prep", {
      APP_DIR: appDir,
      PDF: pdf,
      TRACK: job.track,
      URL: job.url,
      RENDER_CHECK: RENDER_CHECK,
      RECIPIENT_RULE: recipientRule,
      EMAIL_EXAMPLE:
        candidates.length > 0 && existsSync(join(WORKSPACE, example))
          ? `\n\nTone exemplar (${example}):\n\n${read(example).slice(0, 10_000)}`
          : "",
      ROLE: role,
      JD: jd === "" ? "(not captured: open the link with WebFetch)" : jd,
      SOURCE_README: read("resume-source/README.md"),
      LEDGER: read("resume-source/MASTER-RESUME-EVIDENCE.md"),
      RATIONALE: read(`resume-source/${job.track}/RATIONALE.md`),
      BASELINE: read(`resume-source/${job.track}/resume_content.py`),
    }),
    allow: ["Read", "WebFetch", `Write(/${appDir}/**)`, `Edit(/${appDir}/**)`, `Bash(bash ${RENDER_CHECK}:*)`],
    cwd: WORKSPACE, // so the workspace CLAUDE.md is loaded: it is the rulebook
    schema: RESULT_JSON_SCHEMA,
    model,
    effort: "high",
    timeoutMin: 25,
    log,
  });
  const parsed = resultSchema.safeParse(run.structured);
  if (!parsed.success) throw new Error(`Prep output failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const result = parsed.data;
  if (result.fit === "not_a_fit") {
    recordHistory(job, "skipped", `Not a fit: ${result.reason}`);
    throw new NotAFit(result.reason);
  }

  // The tailoring notes go into the README (CLAUDE.md step 2), written here instead of by the session.
  appendFileSync(
    join(appDir, "README.md"),
    [
      "",
      `## Tailoring notes (${new Date().toISOString().slice(0, 10)})`,
      `- **Verdict:** ${result.fit}. ${result.reason}`,
      `- **Title:** ${result.title}`,
      ...result.changes.map((change) => `- ${change}`),
      result.keywordsMatched.length > 0 ? `- **Matched:** ${result.keywordsMatched.join(", ")}` : "",
      result.missing.length > 0 ? `- **Not claimed (no evidence):** ${result.missing.join(", ")}` : "",
      result.notes.trim() !== "" ? `- **Notes:** ${result.notes.trim()}` : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );

  // The session renders the PDF; render once more from its final content so the file matches it.
  const render = spawnSync(PYTHON, [join(WORKSPACE, "tools", "generate_pdf.py"), "--content", join(appDir, "resume_content.py"), "--out", pdf], {
    cwd: WORKSPACE,
    encoding: "utf8",
  });
  if (render.status !== 0) throw new Error(`generate_pdf failed: ${(render.stderr || render.stdout).slice(0, 400)}`);
  const problem = checkPdf(pdf);
  if (problem !== undefined) throw new Error(`Resume check failed: ${problem}`);

  const notes: string[] = [];
  let email: { to: string; source: string; subject: string; body: string } | null = null;
  if (result.recipient !== null && result.email !== null) {
    const to = result.recipient.trim().toLowerCase();
    if (!candidates.includes(to)) {
      notes.push(`email not drafted: ${to} was not one of the addresses found on the posting`);
    } else if (/—/.test(result.email.body)) {
      notes.push("email not drafted: it contained an em-dash");
    } else {
      const source = await verifyRecipient(to, [job.url], log);
      if (source !== undefined) email = { to, source, subject: result.email.subject.trim(), body: result.email.body.trim() };
    }
  }

  recordHistory(job, "prepared", `Prep agent: ${result.fit}. ${result.reason}`);

  const summary = [
    `Fit: ${result.fit}. ${result.reason}`,
    `Resume: titled "${result.title}", tailored from the ${job.track} baseline following CLAUDE.md.`,
    result.changes.length > 0 ? `Changed: ${result.changes.join("; ")}` : "",
    result.keywordsMatched.length > 0 ? `JD keywords matched: ${result.keywordsMatched.join(", ")}` : "",
    result.missing.length > 0 ? `Missing (not claimed): ${result.missing.join(", ")}` : "",
    result.notes.trim() !== "" ? `Notes: ${result.notes.trim()}` : "",
    ...notes,
    email !== null ? `Email to ${email.to} (address seen on ${email.source})` : "No verified email address: apply through the form",
  ]
    .filter(Boolean)
    .join("\n");

  const done = await completePrep({
    roleId: job.roleId,
    pdfBase64: readFileSync(pdf).toString("base64"),
    filename,
    folder: appRel,
    summary,
    email,
  });
  return email === null
    ? "resume ready (form)"
    : done.drafted
      ? `resume ready, Gmail draft to ${email.to}`
      : `resume ready, email held: ${done.emailError ?? "?"}`;
}

class NotAFit extends Error {}

const once = process.argv.includes("--once");
void runAgent("prep", async (log, settings) => {
  const notes: string[] = [];
  for (let handled = 0; handled < (once ? 1 : MAX_PER_RUN); handled++) {
    const claimed = await rpc<unknown>("roles.claimPrep", { now: Date.now() });
    if (claimed === null) break;
    const job = jobSchema.parse(claimed);
    try {
      const outcome = await prepare(job, log, settings.prepModel);
      log(`  ${outcome}`);
      notes.push(`${job.company}: ${outcome}`);
    } catch (error) {
      const message = error instanceof NotAFit ? `Not a fit after reading the JD: ${error.message}` : error instanceof Error ? error.message : String(error);
      log(`  FAILED: ${message}`);
      notes.push(`${job.company}: ${error instanceof NotAFit ? "not a fit" : "failed"}`);
      await rpc("roles.failPrep", {
        roleId: job.roleId,
        error: message,
        final: error instanceof NotAFit,
        now: Date.now(),
      });
    }
  }
  return notes.length === 0 ? "nothing queued" : notes.join("; ");
});
