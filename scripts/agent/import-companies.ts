/**
 * Add companies to the collector's catalog from a list, with no Claude call.
 *
 *   pnpm companies:import <file | URL | github-repo-URL> [--dry-run]
 *
 * The list can be anything with company names or job-board links: a GitHub
 * README (markdown lists or tables), a text file with one company per line, or
 * a page of links. Direct job-board links (jobs.lever.co/acme, ...) are used as
 * they are; for plain names the script tries the obvious board ids on
 * Greenhouse, Lever and Ashby. A board is added only if it answers with at
 * least one open job. Everything runs as plain HTTP: zero tokens.
 */
import { readFileSync } from "node:fs";
import type { AtsProvider } from "../../src/lib/sources/types";
import { fetchBoard } from "./feeds";
import { rpc } from "./lib";

type Candidate = { name: string; website?: string; boards: Array<{ provider: AtsProvider; slug: string }> };

const BOARD_PATTERNS: Array<[AtsProvider, RegExp]> = [
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9_-]+)/g],
  ["lever", /jobs\.lever\.co\/([A-Za-z0-9_.-]+)/g],
  ["ashby", /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g],
  ["workable", /apply\.workable\.com\/([A-Za-z0-9_-]+)/g],
  ["smartrecruiters", /jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g],
  ["recruitee", /([a-z0-9-]+)\.recruitee\.com/g],
  ["personio", /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/g],
];
const GUESS_PROVIDERS: AtsProvider[] = ["greenhouse", "lever", "ashby"];
const SKIP_SLUGS = new Set(["embed", "api", "v1", "jobs", "www"]);

async function loadText(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return readFileSync(source, "utf8");
  const repo = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/.exec(source);
  const url = repo ? `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/README.md` : source;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

function slugGuesses(name: string, website?: string): string[] {
  const base = name.toLowerCase().replace(/\(.*?\)/g, "").replace(/&/g, "and").trim();
  const guesses = [base.replace(/[^a-z0-9]+/g, ""), base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")];
  const host = website ? /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\./i.exec(website)?.[1]?.toLowerCase() : undefined;
  if (host) guesses.push(host);
  return [...new Set(guesses.filter((slug) => slug.length >= 2 && slug.length <= 60))];
}

function parse(text: string): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const line of text.split("\n")) {
    const boards: Candidate["boards"] = [];
    for (const [provider, pattern] of BOARD_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const slug = decodeURIComponent(match[1] ?? "").replace(/\.$/, "");
        if (slug !== "" && !SKIP_SLUGS.has(slug)) boards.push({ provider, slug });
      }
    }
    // "[Name](https://site)" in a list item or table row, else a short plain line.
    const link = /\[([^\]]{2,60})\]\((https?:\/\/[^)\s]+)\)/.exec(line);
    let name = link?.[1]?.trim();
    const website = link?.[2];
    if (name === undefined) {
      const plain = line.replace(/^[\s*\-|#>\d.]+/, "").replace(/\|.*$/, "").trim();
      if (plain.length >= 2 && plain.length <= 40 && !/\s{2,}|[:.!?]$/.test(plain) && plain.split(" ").length <= 5) name = plain;
    }
    if (name === undefined && boards.length === 0) continue;
    const key = (name ?? boards[0]!.slug).toLowerCase();
    const entry = out.get(key) ?? { name: name ?? boards[0]!.slug, website, boards: [] };
    entry.boards.push(...boards);
    out.set(key, entry);
  }
  return [...out.values()];
}

async function firstLiveBoard(candidate: Candidate): Promise<{ provider: AtsProvider; slug: string; jobs: number } | null> {
  const tries: Candidate["boards"] =
    candidate.boards.length > 0
      ? candidate.boards
      : slugGuesses(candidate.name, candidate.website).flatMap((slug) => GUESS_PROVIDERS.map((provider) => ({ provider, slug })));
  for (const board of tries) {
    try {
      const jobs = await fetchBoard({ name: candidate.name, provider: board.provider, slug: board.slug });
      if (jobs.length > 0) return { ...board, jobs: jobs.length };
    } catch {
      // not this one
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (source === undefined) throw new Error("Usage: pnpm companies:import <file | URL> [--dry-run]");

  const known = new Set((await rpc<string[]>("companies.knownNames")).map((name) => name.toLowerCase()));
  const candidates = parse(await loadText(source)).filter((candidate) => !known.has(candidate.name.toLowerCase()));
  console.log(`${candidates.length} new names in the list; checking their job boards...`);

  const found: Array<{ name: string; provider: AtsProvider; slug: string; website?: string; note: string }> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < candidates.length) {
        const candidate = candidates[next++]!;
        const board = await firstLiveBoard(candidate);
        if (board === null) continue;
        found.push({ name: candidate.name, provider: board.provider, slug: board.slug, website: candidate.website, note: `[import] ${source}`.slice(0, 300) });
        console.log(`  ok ${candidate.name} (${board.provider}:${board.slug}) · ${board.jobs} jobs`);
      }
    }),
  );

  if (dryRun) {
    console.log(`dry run: ${found.length} would be added`);
    return;
  }
  let inserted = 0;
  for (let i = 0; i < found.length; i += 200) {
    const result = await rpc<{ inserted: number }>("companies.upsert", { companies: found.slice(i, i + 200), addedBy: "owner", now: Date.now() });
    inserted += result.inserted;
  }
  console.log(`done: ${candidates.length} checked, ${found.length} have a live board, ${inserted} added to the catalog`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
