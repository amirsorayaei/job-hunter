/**
 * Prep agent: tailors the resume (and writes the email) for roles queued in
 * the app, automatically for high scores or by the owner's "Prepare" button.
 *
 *   pnpm agent:prep            prepare everything queued (at most 6 per run)
 *   pnpm agent:prep --once     prepare at most one
 *
 * Template-based, to spend as few tokens as possible. For each role:
 * 1. The script reads the posting and scaffolds applications/<slug>/.
 * 2. ONE Claude call with no tools sees the posting plus a menu of the approved
 *    pieces (tools/resume_tailor.py) and picks: fit, title, which bullets and in
 *    what order, skill order, and which fixed email paragraphs to use.
 * 3. tools/resume_tailor.py builds the resume from the frozen baseline (choose
 *    and reorder only, never rewrite); prepTemplates.ts assembles the email.
 * 4. Renders the PDF (one page required), verifies any recipient address (it
 *    must be on the posting and its domain must take mail), then uploads PDF +
 *    email. The app makes the Gmail draft; nothing is ever sent from here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { emailsIn } from "../../src/lib/agent/filter";
import { completePrep, domainAcceptsMail, emptyDir, pageText, prompt, rpc, runAgent, runClaude, WORKSPACE } from "./lib";
import { buildEmail, checkPick, EVIDENCE, GAPS } from "./prepTemplates";

const PYTHON = join(WORKSPACE, ".venv", "bin", "python");
const MAX_PER_RUN = 6;

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
  summaryFocus: z.array(z.string()),
  skills: z.array(z.object({ line: z.number(), items: z.array(z.string()) })),
  jobs: z.array(z.object({ job: z.number(), bullets: z.array(z.number()) })),
  keywordsMatched: z.array(z.string()),
  missing: z.array(z.string()),
  recipient: z.string().nullable(),
  email: z.object({ opener: z.string(), evidence: z.array(z.string()), gap: z.string().nullable() }).nullable(),
});

const RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fit", "reason", "title", "summaryFocus", "skills", "jobs", "keywordsMatched", "missing", "recipient", "email"],
  properties: {
    fit: { type: "string", enum: ["good", "workable", "not_a_fit"] },
    reason: { type: "string" },
    title: { type: "string" },
    summaryFocus: { type: "array", items: { type: "string" }, maxItems: 2 },
    skills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "items"],
        properties: { line: { type: "integer" }, items: { type: "array", items: { type: "string" } } },
      },
    },
    jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["job", "bullets"],
        properties: { job: { type: "integer" }, bullets: { type: "array", items: { type: "integer" } } },
      },
    },
    keywordsMatched: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    recipient: { anyOf: [{ type: "null" }, { type: "string" }] },
    email: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["opener", "evidence", "gap"],
          properties: {
            opener: { type: "string" },
            evidence: { type: "array", items: { type: "string" }, maxItems: 2 },
            gap: { anyOf: [{ type: "null" }, { type: "string" }] },
          },
        },
      ],
    },
  },
};

function slugFor(job: Job): string {
  const raw = `${job.company}-${job.title}`
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return raw.slice(0, 60).replace(/-+$/, "");
}

function renderPdf(appDir: string, pdf: string): number {
  const render = spawnSync(
    PYTHON,
    [join(WORKSPACE, "tools", "generate_pdf.py"), "--content", join(appDir, "resume_content.py"), "--out", pdf],
    { cwd: WORKSPACE, encoding: "utf8" },
  );
  if (render.status !== 0) throw new Error(`generate_pdf failed: ${(render.stderr || render.stdout).slice(0, 400)}`);
  const info = spawnSync("pdfinfo", [pdf], { encoding: "utf8" });
  const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1] ?? "0");
  if (pages === 0) throw new Error("pdfinfo could not read the PDF");
  return pages;
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

function runTailor(command: "menu" | "build", track: string, input?: object, out?: string): { ok: boolean; stdout: string } {
  const args = [join(WORKSPACE, "tools", "resume_tailor.py"), command, "--track", track, ...(out !== undefined ? ["--out", out] : [])];
  const run = spawnSync("python3", args, { cwd: WORKSPACE, encoding: "utf8", input: input !== undefined ? JSON.stringify(input) : undefined });
  return { ok: run.status === 0, stdout: run.stdout + run.stderr };
}

async function prepare(job: Job, log: (m: string) => void, model: string): Promise<string> {
  const slug = slugFor(job);
  const appRel = `applications/${slug}`;
  const appDir = join(WORKSPACE, appRel);
  log(`prepare ${job.company} · ${job.title} → ${appRel}`);

  if (!existsSync(appDir)) {
    const scaffold = spawnSync("python3", [join(WORKSPACE, "tools", "new_application.py"), slug], { cwd: WORKSPACE, encoding: "utf8" });
    if (scaffold.status !== 0) throw new Error(`new_application failed: ${scaffold.stderr.slice(0, 300)}`);
  }

  // The script reads the posting, so the model does not have to browse for it.
  let jd = "";
  try {
    jd = (await pageText(job.url)).slice(0, 14_000);
  } catch {
    jd = "";
  }
  const thin = jd.length < 1500;
  const candidates = [...new Set([...(job.applyEmail !== undefined ? [job.applyEmail.toLowerCase()] : []), ...candidateRecipients(jd)])];
  const recipientRule =
    candidates.length > 0
      ? `one of these addresses, found on the posting: ${candidates.join(", ")}. Pick the one that takes applications, or null if none of them does. Never any other address.`
      : "always null. No application address was found; he will apply through the form.";

  const menu = runTailor("menu", job.track);
  if (!menu.ok) throw new Error(`resume menu failed: ${menu.stdout.slice(0, 300)}`);

  const role = [
    `- Company: ${job.company}`,
    `- Title: ${job.title}`,
    `- Posting: ${job.url}`,
    `- Track (which baseline resume): ${job.track}`,
    `- Employer's location wording: ${job.remoteWording}`,
    `- Screener's view, to verify against the JD: why it fits: ${job.whyFit} Gaps: ${job.gaps}`,
    `- Must-haves noted: ${job.mustHaves.join(", ")}`,
  ].join("\n");
  const evidence = Object.entries(EVIDENCE)
    .filter(([, item]) => item.tracks.includes(job.track))
    .map(([id, item]) => `- ${id}: ${item.about}`)
    .join("\n");
  const gaps = Object.entries(GAPS)
    .map(([id, item]) => `- ${id}: ${item.about}`)
    .join("\n");

  const run = await runClaude({
    prompt: prompt("prep", {
      ROLE: role,
      JD: thin
        ? `(The page text could not be read automatically, so open ${job.url} yourself with WebFetch and read the whole job description first.)\n${jd}`
        : jd,
      PROFILE: prompt("profile"),
      RECIPIENT_RULE: recipientRule,
      MENU: menu.stdout.trim(),
      EVIDENCE: evidence,
      GAPS: gaps,
    }),
    allow: thin ? ["WebFetch"] : [],
    cwd: emptyDir(),
    schema: RESULT_JSON_SCHEMA,
    model,
    effort: "medium",
    timeoutMin: 15,
    log,
  });
  const parsed = resultSchema.safeParse(run.structured);
  if (!parsed.success) throw new Error(`Prep output failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const result = parsed.data;
  if (result.fit === "not_a_fit") throw new NotAFit(result.reason);

  // Build the resume from the baseline. A bad selection falls back to the baseline order.
  const notes: string[] = [];
  const selection = { title: result.title, summaryFocus: result.summaryFocus, skills: result.skills, jobs: result.jobs };
  let built = runTailor("build", job.track, selection, appDir);
  if (built.ok) {
    const warnings = (JSON.parse(built.stdout) as { warnings?: string[] }).warnings ?? [];
    notes.push(...warnings);
  } else {
    notes.push(`model's selection rejected (${built.stdout.slice(0, 200).replace(/\s+/g, " ")}); used the baseline order`);
    built = runTailor("build", job.track, { summaryFocus: ["launch", "conversion"] }, appDir);
    if (!built.ok) throw new Error(`resume build failed: ${built.stdout.slice(0, 300)}`);
  }

  const companySlug = job.company.replace(/\(.*?\)/g, "").replace(/[^A-Za-z0-9]+/g, "") || "Company";
  const filename = `YourName-Resume-${companySlug}.pdf`;
  const pdf = join(appDir, filename);
  let pages = renderPdf(appDir, pdf);
  if (pages !== 1) {
    notes.push(`tailored version was ${pages} pages; used the baseline order`);
    const fallback = runTailor("build", job.track, { summaryFocus: ["launch", "conversion"] }, appDir);
    if (!fallback.ok) throw new Error(`resume build failed: ${fallback.stdout.slice(0, 300)}`);
    pages = renderPdf(appDir, pdf);
  }
  if (pages !== 1) throw new Error(`Resume is ${pages} pages even from the baseline`);

  let email: { to: string; source: string; subject: string; body: string } | null = null;
  if (result.recipient !== null && result.email !== null) {
    const to = result.recipient.trim().toLowerCase();
    const problem = !candidates.includes(to) ? `${to} was not one of the addresses found on the posting` : checkPick(result.email, job.track);
    if (problem !== undefined) {
      notes.push(`email not drafted: ${problem}`);
    } else {
      const source = await verifyRecipient(to, [job.url], log);
      if (source !== undefined) {
        const built = buildEmail({ company: job.company, title: result.title, pick: result.email });
        email = { to, source, subject: built.subject, body: built.body };
      }
    }
  }

  writeFileSync(
    join(appDir, "README.md"),
    [
      `# ${slug}`,
      "",
      `- **Company:** ${job.company}`,
      `- **Role:** ${job.title}`,
      `- **Link:** ${job.url}`,
      "- **Status:** prepared (templated)",
      "",
      "## Job description (page text at prep time)",
      jd === "" ? "(not captured)" : jd.slice(0, 6000),
      "",
      "## Tailoring notes",
      `Fit: ${result.fit}. ${result.reason}`,
      `Title: ${result.title}. Summary focus: ${result.summaryFocus.join(", ")}.`,
      ...notes,
      "",
    ].join("\n"),
  );

  const summary = [
    `Fit: ${result.fit}. ${result.reason}`,
    `Resume: titled "${result.title}", built from the ${job.track} baseline by choosing and reordering approved bullets and skills.`,
    result.keywordsMatched.length > 0 ? `JD keywords matched: ${result.keywordsMatched.join(", ")}` : "",
    result.missing.length > 0 ? `Missing (not claimed): ${result.missing.join(", ")}` : "",
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
      notes.push(`${job.company}: failed`);
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
