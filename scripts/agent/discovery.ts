/**
 * Open-web discovery shared by the Web search agent and the Startup finder.
 *
 * Claude searches the web (about 25-30 minutes) and returns roles for BOTH
 * tracks in one go, each tagged frontend or full-stack. Every address is
 * verified, duplicates are dropped, and the rest land in the Roles list.
 */
import { z } from "zod";
import { classify, normUrl } from "../../src/lib/agentDedupe";
import { emailsIn } from "../../src/lib/agent/filter";
import { domainAcceptsMail, pageText, prompt, rpc, runClaude, seenHistory } from "./lib";

type Track = "frontend" | "fullstack";

const item = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  track: z.enum(["frontend", "fullstack"]),
  score: z.number().min(0).max(100),
  workMode: z.enum(["remote", "visa", "turkey", "unclear"]),
  remoteWording: z.string(),
  whyFit: z.string(),
  gaps: z.string(),
  mustHaves: z.array(z.string()),
  applyEmail: z.string().optional(),
  applyEmailSource: z.string().optional(),
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "title", "url", "track", "score", "workMode", "remoteWording", "whyFit", "gaps", "mustHaves"],
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          url: { type: "string", description: "Official employer or ATS posting URL" },
          track: { type: "string", enum: ["frontend", "fullstack"] },
          score: { type: "integer", minimum: 0, maximum: 100 },
          workMode: { type: "string", enum: ["remote", "visa", "turkey", "unclear"] },
          remoteWording: { type: "string" },
          whyFit: { type: "string", description: "Start with the funding stage and team size" },
          gaps: { type: "string" },
          mustHaves: { type: "array", items: { type: "string" }, maxItems: 8 },
          applyEmail: { type: "string" },
          applyEmailSource: { type: "string", description: "URL of the official page showing the address" },
        },
      },
    },
  },
};

async function verifiedEmail(candidate: string | undefined, text: string): Promise<string | undefined> {
  if (candidate === undefined) return undefined;
  const address = candidate.trim().toLowerCase();
  if (!emailsIn(text).includes(address)) return undefined;
  return (await domainAcceptsMail(address)) ? address : undefined;
}

export async function discover(
  log: (message: string) => void,
  model: string,
  options: { promptName: "explore" | "startups"; source: string },
): Promise<string> {
  const history = seenHistory();
  const recent = history
    .slice(-150)
    .map((entry) => `${entry.company ?? "?"}: ${entry.role ?? ""}`)
    .join("; ");
  const catalog = await rpc<string[]>("companies.knownNames");
  log(`searching the open web (${model})`);
  const run = await runClaude({
    prompt: prompt(options.promptName, {
      CATALOG_SIZE: String(catalog.length),
      PROFILE: prompt("profile"),
      FRONTEND_FOCUS: prompt("frontend"),
      FULLSTACK_FOCUS: prompt("fullstack"),
      SEEN: recent,
    }),
    allow: ["WebSearch", "WebFetch"],
    schema: SCHEMA,
    model: model,
    timeoutMin: 30,
    log,
  });
  const parsed = z.object({ findings: z.array(item) }).safeParse(run.structured);
  if (!parsed.success) throw new Error(`Startup output failed validation: ${parsed.error.issues[0]?.message ?? "?"}`);

  const unknown = new Set(await rpc<string[]>("postings.unknownKeys", { keys: parsed.data.findings.map((f) => normUrl(f.url)) }));
  const byTrack: Record<Track, Array<Record<string, unknown>>> = { frontend: [], fullstack: [] };
  for (const finding of parsed.data.findings) {
    const key = normUrl(finding.url);
    const verdict = classify(finding, history);
    if (!unknown.has(key) || verdict === "duplicate") {
      log(`  already seen: ${finding.company} · ${finding.title}`);
      continue;
    }
    let applyEmail: string | undefined;
    let applyEmailSource: string | undefined;
    if (finding.applyEmail !== undefined) {
      const source = finding.applyEmailSource ?? finding.url;
      try {
        applyEmail = await verifiedEmail(finding.applyEmail, await pageText(source));
        applyEmailSource = applyEmail !== undefined ? source : undefined;
      } catch {
        applyEmail = undefined;
      }
      if (applyEmail === undefined) log(`  dropped unverified email for ${finding.company}`);
    }
    byTrack[finding.track].push({
      key,
      company: finding.company,
      title: finding.title,
      url: finding.url,
      source: options.source,
      score: Math.round(finding.score),
      workMode: finding.workMode,
      remoteWording: finding.remoteWording,
      whyFit: finding.whyFit,
      gaps: finding.gaps,
      mustHaves: finding.mustHaves.slice(0, 8),
      knownCompany: verdict === "known_company" ? true : undefined,
      ...(applyEmail !== undefined ? { applyEmail, applyEmailSource } : {}),
    });
    log(`  ${finding.score} · ${finding.company} · ${finding.title}${applyEmail ? ` · email ${applyEmail}` : ""}`);
  }
  let inserted = 0;
  let queued = 0;
  for (const track of ["frontend", "fullstack"] as const) {
    if (byTrack[track].length === 0) continue;
    const result = await rpc<{ inserted: number; autoQueued: number }>("roles.ingest", { track, findings: byTrack[track], now: Date.now() });
    inserted += result.inserted;
    queued += result.autoQueued;
  }
  return `${parsed.data.findings.length} found, ${inserted} new roles, ${queued} auto-prepared`;
}
