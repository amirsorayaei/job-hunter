/**
 * Track agent (frontend or full-stack). Checks every hour, scores on the
 * interval set in Settings.
 *
 *   pnpm agent:score --track frontend|fullstack
 *
 * Screens the postings the collector queued for this track (Claude reads the
 * posting text it is given; no browsing). Costs tokens only when there is
 * something new. Searching the open web is the separate Web search agent.
 * Results land in the Roles list; the best are prepared automatically.
 */
import { z } from "zod";
import { emailsIn } from "../../src/lib/agent/filter";
import { domainAcceptsMail, emptyDir, prompt, readState, rpc, runAgent, runClaude, writeState } from "./lib";

type Track = "frontend" | "fullstack";

const BATCH = 20;
const MAX_BATCHES = 3;

const workMode = z.enum(["remote", "visa", "turkey", "unclear"]);

const scoreItem = z.object({
  key: z.string(),
  score: z.number().min(0).max(100),
  workMode,
  remoteWording: z.string(),
  whyFit: z.string(),
  gaps: z.string(),
  mustHaves: z.array(z.string()),
  applyEmail: z.string().optional(),
});
const scoreOutput = z.object({ results: z.array(scoreItem) });

const SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "score", "workMode", "remoteWording", "whyFit", "gaps", "mustHaves"],
        properties: {
          key: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          workMode: { type: "string", enum: ["remote", "visa", "turkey", "unclear"] },
          remoteWording: { type: "string" },
          whyFit: { type: "string" },
          gaps: { type: "string" },
          mustHaves: { type: "array", items: { type: "string" }, maxItems: 8 },
          applyEmail: { type: "string" },
        },
      },
    },
  },
};

interface Claimed {
  key: string;
  company: string;
  title: string;
  url: string;
  location: string;
  source: string;
  description: string;
  postedAt?: string;
  knownCompany?: boolean;
}

function parseArgs(): { track: Track } {
  const args = process.argv.slice(2);
  const track = args[args.indexOf("--track") + 1];
  if (track !== "frontend" && track !== "fullstack") {
    throw new Error("Usage: score --track frontend|fullstack");
  }
  return { track };
}

function trackFocus(track: Track): string {
  return prompt(track);
}

/** An address is kept only if it really appears in the posting and its domain takes mail. */
async function verifiedEmail(candidate: string | undefined, text: string): Promise<string | undefined> {
  if (candidate === undefined) return undefined;
  const address = candidate.trim().toLowerCase();
  if (!emailsIn(text).includes(address)) return undefined;
  return (await domainAcceptsMail(address)) ? address : undefined;
}

async function screen(track: Track, log: (m: string) => void, model: string): Promise<{ scored: number; shown: number; queued: number }> {
  let scored = 0;
  let shown = 0;
  let queued = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const postings = await rpc<Claimed[]>("postings.claim", { track, limit: BATCH, now: Date.now() });
    if (postings.length === 0) break;
    log(`screening ${postings.length} postings`);

    const input = postings.map((posting) => ({
      key: posting.key,
      company: posting.company,
      title: posting.title,
      location: posting.location,
      source: posting.source,
      postedAt: posting.postedAt,
      text: posting.description.slice(0, 3500),
    }));
    const run = await runClaude({
      prompt: prompt("score", {
        TRACK: track === "frontend" ? "Frontend" : "Full-Stack",
        PROFILE: prompt("profile"),
        TRACK_FOCUS: trackFocus(track),
        POSTINGS: JSON.stringify(input, null, 1),
      }),
      allow: [],
      cwd: emptyDir(),
      schema: SCORE_SCHEMA,
      model,
      effort: "low",
      timeoutMin: 25,
      log,
    });
    const parsed = scoreOutput.safeParse(run.structured);
    if (!parsed.success) throw new Error(`Screener output failed validation: ${parsed.error.issues[0]?.message ?? "?"}`);

    const byKey = new Map(postings.map((posting) => [posting.key, posting]));
    const findings = [];
    for (const result of parsed.data.results) {
      const posting = byKey.get(result.key);
      if (posting === undefined) continue;
      // The model's pick, or the one hiring address written in the posting itself.
      const inText = emailsIn(posting.description);
      const applyEmail = await verifiedEmail(result.applyEmail ?? (inText.length === 1 ? inText[0] : undefined), posting.description);
      findings.push({
        key: posting.key,
        company: posting.company,
        title: posting.title,
        url: posting.url,
        source: posting.source,
        score: Math.round(result.score),
        workMode: result.workMode,
        remoteWording: result.remoteWording,
        whyFit: result.whyFit,
        gaps: result.gaps,
        mustHaves: result.mustHaves.slice(0, 8),
        knownCompany: posting.knownCompany,
        ...(applyEmail !== undefined ? { applyEmail, applyEmailSource: posting.url } : {}),
      });
    }
    const ingest = await rpc<{ inserted: number; autoQueued: number }>("roles.ingest", {
      track,
      findings,
      now: Date.now(),
    });
    // Everything handed out is now "seen", including postings the model skipped.
    const scoreFor = new Map(findings.map((finding) => [finding.key, finding.score]));
    await rpc("postings.markScored", {
      results: postings.map((posting) => ({ key: posting.key, score: scoreFor.get(posting.key) ?? 0 })),
    });
    for (const finding of findings.filter((item) => item.score >= 50)) {
      log(`  ${finding.score} · ${finding.company} · ${finding.title}${finding.applyEmail ? ` · email ${finding.applyEmail}` : ""}`);
    }
    scored += postings.length;
    shown += ingest.inserted;
    queued += ingest.autoQueued;
    if (postings.length < BATCH) break;
  }
  return { scored, shown, queued };
}

const { track } = parseArgs();

const SLACK_MS = 10 * 60 * 1000;

function screenDue(settings: { scoreEveryHours: number }): boolean {
  const last = readState<{ lastScreenAt?: number }>(`screen-${track}`, {}).lastScreenAt ?? 0;
  return Date.now() - last >= settings.scoreEveryHours * 3_600_000 - SLACK_MS;
}

void runAgent(
  track,
  async (log, settings) => {
    const notes: string[] = [];
    if (screenDue(settings)) {
      writeState(`screen-${track}`, { lastScreenAt: Date.now() });
      const screened = await screen(track, log, settings.scoreModel);
      notes.push(`screened ${screened.scored}, ${screened.shown} new roles, ${screened.queued} auto-prepared`);
    }
    return notes.join("; ");
  },
  {
    skipIf: (settings) => (screenDue(settings) ? undefined : `next scoring is every ${settings.scoreEveryHours} hours`),
  },
);
