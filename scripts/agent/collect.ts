/**
 * Collector: runs every hour, spends no tokens.
 *
 *   pnpm agent:collect
 *
 * Reads every active company board in the catalog plus the public remote
 * boards, keeps developer roles that are remote, in Turkey, or offer visa
 * help, drops anything seen before, and queues the rest for the frontend or
 * full-stack scoring agent.
 */
import { classify } from "../../src/lib/agentDedupe";
import { normUrl } from "../../src/lib/agentDedupe";
import { isFresh, isRelevantTitle, placementOf, textForScoring, titleKey, trackFor } from "../../src/lib/agent/filter";
import type { AtsProvider } from "../../src/lib/sources/types";
import { FEEDS, fetchBoard, type RawPosting } from "./feeds";
import { readState, rpc, runAgent, seenHistory, writeState } from "./lib";

const DAY = 24 * 60 * 60 * 1000;

const CONCURRENCY = 8;

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await work(items[index]);
      }
    }),
  );
  return out;
}

void runAgent("collector", async (log) => {
  const now = Date.now();
  const companies = await rpc<Array<{ _id: string; name: string; provider: AtsProvider; slug: string }>>(
    "companies.active",
  );
  log(`reading ${companies.length} company boards and ${FEEDS.length} remote boards`);

  const raw: RawPosting[] = [];
  const checks = await pool(companies, CONCURRENCY, async (company) => {
    try {
      const postings = await fetchBoard(company);
      raw.push(...postings);
      return { id: company._id, ok: true, jobCount: postings.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  ${company.name} (${company.provider}:${company.slug}) failed: ${message}`);
      // Only a definite "no such board" counts against it; a network blip does not.
      return /answered (401|403|404|410)\b|schema/.test(message) ? { id: company._id, ok: false } : null;
    }
  });
  const recorded = checks.filter((check) => check !== null);
  for (let i = 0; i < recorded.length; i += 200) {
    await rpc("companies.recordChecks", { results: recorded.slice(i, i + 200), now });
  }

  const feedNotes: string[] = [];
  for (const feed of FEEDS) {
    try {
      const postings = await feed.fetch();
      raw.push(...postings);
      feedNotes.push(`${feed.name} ${postings.length}`);
    } catch (error) {
      feedNotes.push(`${feed.name} failed`);
      log(`  feed ${feed.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Filter: developer title, fresh, reachable for Candidate.
  const relevant = raw.filter(
    (posting) =>
      posting.url !== "" &&
      posting.company !== "" &&
      isRelevantTitle(posting.title) &&
      isFresh(posting.postedAt, now) &&
      placementOf(posting) !== null,
  );

  // Dedupe: within this pass, against the app, and against the workspace history.
  const byKey = new Map<string, RawPosting>();
  for (const posting of relevant) {
    const key = normUrl(posting.url);
    if (key !== "" && !byKey.has(key)) byKey.set(key, posting);
  }
  const unknown = new Set<string>();
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += 500) {
    for (const key of await rpc<string[]>("postings.unknownKeys", { keys: keys.slice(i, i + 500) })) unknown.add(key);
  }
  const history = seenHistory();
  const verdicts = new Map([...byKey.entries()].map(([key, posting]) => [key, classify(posting, history)]));
  const unseen = [...byKey.entries()].filter(([key]) => unknown.has(key) && verdicts.get(key) !== "duplicate");

  // One job listed once per country ("... | UK | Remote", "... | Germany | Remote") is one row.
  // Title keys are remembered for 60 days, so a copy found on a later run is dropped too.
  const titleSeen = readState<Record<string, number>>("title-keys", {});
  for (const [titleKeyText, at] of Object.entries(titleSeen)) if (now - at > 60 * DAY) delete titleSeen[titleKeyText];
  const fresh: typeof unseen = [];
  let sameJob = 0;
  for (const entry of unseen) {
    const keyText = titleKey(entry[1].company, entry[1].title);
    if (titleSeen[keyText] !== undefined) {
      sameJob++;
      continue;
    }
    titleSeen[keyText] = now;
    fresh.push(entry);
  }
  writeState("title-keys", titleSeen);

  const queued = fresh.map(([key, posting]) => ({
    key,
    track: trackFor(posting.title),
    company: posting.company,
    title: posting.title,
    url: posting.url,
    location: `${posting.location}${placementOf(posting) === "visa" ? " (visa/relocation mentioned)" : ""}`.trim(),
    source: posting.source,
    // The app keeps 6,000 characters; eligibility lines from further down are moved up so they survive.
    description: textForScoring(posting.description, 4000),
    postedAt: posting.postedAt,
    knownCompany: verdicts.get(key) === "known_company" ? true : undefined,
  }));
  let inserted = 0;
  for (let i = 0; i < queued.length; i += 100) {
    const result = await rpc<{ inserted: number }>("postings.add", { postings: queued.slice(i, i + 100), now });
    inserted += result.inserted;
  }
  const frontend = queued.filter((posting) => posting.track === "frontend").length;
  const failedBoards = checks.filter((check) => check === null || !check.ok).length;
  return `${raw.length} postings read (${companies.length} boards${failedBoards > 0 ? `, ${failedBoards} failed` : ""}; ${feedNotes.join(", ")}), ${relevant.length} relevant, ${inserted} new queued (${frontend} frontend, ${inserted - frontend} full-stack)${sameJob > 0 ? `, ${sameJob} same-job copies for other countries skipped` : ""}`;
}, { ignoreQuiet: true });
