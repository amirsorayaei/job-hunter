/**
 * Public job feeds the collector reads besides the company catalog. Each one
 * returns plain postings; filtering happens in collect.ts. Every fetch is a
 * GET to a fixed host with a timeout, and a feed that fails just returns [].
 */
import { htmlToText } from "../../src/lib/sources/types";
import { adapterFor } from "../../src/lib/sources/adapters";
import type { AtsProvider } from "../../src/lib/sources/types";
import { BROWSER_UA } from "./lib";

export interface RawPosting {
  company: string;
  title: string;
  url: string;
  location: string;
  description: string;
  postedAt?: string;
  workplaceType?: string;
  source: string;
}

async function getText(url: string, accept = "application/json"): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": BROWSER_UA, accept },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return await response.text();
}

async function getJson(url: string): Promise<unknown> {
  return JSON.parse(await getText(url));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Numeric and the common named HTML entities htmlToText leaves behind. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** RemoteOK double-encodes UTF-8 ("Sothebyâs"); undo it when it is clearly that. */
function fixMojibake(value: string): string {
  if (!/[ÂÃâ][\u0080-\u00ff]/.test(value)) return value;
  const fixed = Buffer.from(value, "latin1").toString("utf8");
  return fixed.includes("\ufffd") ? value : fixed;
}

// ── Company boards (via the tested ATS adapters) ───────────────────────────

export async function fetchBoard(company: { name: string; provider: AtsProvider; slug: string }): Promise<RawPosting[]> {
  const adapter = adapterFor(company.provider);
  const out: RawPosting[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const url = adapter.listUrl(company.slug, cursor);
    const raw = company.provider === "personio" ? await getText(url, "application/xml") : await getJson(url);
    const parsed = adapter.parse(raw, { slug: company.slug, companyName: company.name });
    if (parsed.result.outcome === "failed" || parsed.result.outcome === "blocked") {
      throw new Error(`${company.provider}:${company.slug} ${parsed.result.termination}`);
    }
    for (const job of parsed.jobs) {
      out.push({
        company: company.name,
        title: job.title,
        url: job.canonicalUrl,
        location: job.locations
          .map((place) => [place.city, place.region, place.country].filter(Boolean).join(", "))
          .filter(Boolean)
          .join(" / "),
        description: job.descriptionText ?? "",
        postedAt: job.postedAt ?? undefined,
        workplaceType: job.workplaceType,
        source: company.provider,
      });
    }
    cursor = parsed.result.nextCursor;
    if (cursor === undefined) break;
  }
  return out;
}

// ── Remote boards ──────────────────────────────────────────────────────────

async function remotive(): Promise<RawPosting[]> {
  const body = record(await getJson("https://remotive.com/api/remote-jobs?category=software-dev&limit=300"));
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  return jobs.map((item) => {
    const job = record(item);
    return {
      company: str(job.company_name),
      title: str(job.title),
      url: str(job.url),
      location: `Remote ${str(job.candidate_required_location)}`.trim(),
      description: htmlToText(str(job.description)) ?? "",
      postedAt: str(job.publication_date) || undefined,
      workplaceType: "remote",
      source: "remotive",
    };
  });
}

async function remoteOk(): Promise<RawPosting[]> {
  const body = await getJson("https://remoteok.com/api");
  const items = Array.isArray(body) ? body.slice(1) : [];
  return items.map((item) => {
    const job = record(item);
    return {
      company: fixMojibake(str(job.company)),
      title: fixMojibake(str(job.position)),
      url: str(job.url),
      location: `Remote ${str(job.location)}`.trim(),
      description: fixMojibake(htmlToText(str(job.description)) ?? ""),
      postedAt: str(job.date) || undefined,
      workplaceType: "remote",
      source: "remoteok",
    };
  });
}

async function himalayas(): Promise<RawPosting[]> {
  const out: RawPosting[] = [];
  for (const offset of [0, 100]) {
    const body = record(await getJson(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`));
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    for (const item of jobs) {
      const job = record(item);
      const restrictions = Array.isArray(job.locationRestrictions) ? job.locationRestrictions.map(String) : [];
      out.push({
        company: str(job.companyName),
        title: str(job.title),
        url: str(job.applicationLink) || str(job.guid),
        location: `Remote ${restrictions.join(", ") || "worldwide"}`,
        description: htmlToText(str(job.description)) ?? str(job.excerpt),
        postedAt: typeof job.pubDate === "number" ? new Date(job.pubDate * 1000).toISOString() : undefined,
        workplaceType: "remote",
        source: "himalayas",
      });
    }
  }
  return out;
}

async function arbeitnow(): Promise<RawPosting[]> {
  const body = record(await getJson("https://www.arbeitnow.com/api/job-board-api"));
  const jobs = Array.isArray(body.data) ? body.data : [];
  return jobs.map((item) => {
    const job = record(item);
    const tags = Array.isArray(job.tags) ? job.tags.map(String).join(", ") : "";
    return {
      company: str(job.company_name),
      title: str(job.title),
      url: str(job.url),
      location: `${job.remote === true ? "Remote " : ""}${str(job.location)}`.trim(),
      description: `${tags}\n${htmlToText(str(job.description)) ?? ""}`,
      postedAt: typeof job.created_at === "number" ? new Date(job.created_at * 1000).toISOString() : undefined,
      workplaceType: job.remote === true ? "remote" : "unknown",
      source: "arbeitnow",
    };
  });
}

/** This month's Hacker News "Who is hiring?": one posting per top-level comment. */
async function hackerNews(): Promise<RawPosting[]> {
  const search = record(
    await getJson("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5"),
  );
  const hits = Array.isArray(search.hits) ? search.hits.map(record) : [];
  const story = hits.find((hit) => /who is hiring/i.test(str(hit.title)));
  if (story === undefined) return [];
  const thread = record(await getJson(`https://hn.algolia.com/api/v1/items/${str(story.objectID)}`));
  const children = Array.isArray(thread.children) ? thread.children.map(record) : [];
  const out: RawPosting[] = [];
  for (const child of children) {
    const html = str(child.text);
    const text = decodeEntities(htmlToText(html) ?? "");
    if (text.length < 40) continue;
    // The header line ("Company | Role | Location | ...") is the first paragraph.
    const header = decodeEntities(htmlToText(html.split(/<p>/i)[0]) ?? "");
    const parts = header.split("|").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const role =
      parts.find((part) => /engineer|developer|front|full|stack|react|software/i.test(part)) ?? parts[1];
    out.push({
      company: parts[0].slice(0, 80),
      title: role.slice(0, 160),
      url: `https://news.ycombinator.com/item?id=${String(child.id)}`,
      location: parts.filter((part) => /remote|onsite|on-site|hybrid|,|visa/i.test(part)).join(" / "),
      description: text,
      postedAt: str(child.created_at) || undefined,
      source: "hn",
    });
  }
  return out;
}

export const FEEDS: Array<{ name: string; fetch: () => Promise<RawPosting[]> }> = [
  { name: "remotive", fetch: remotive },
  { name: "remoteok", fetch: remoteOk },
  { name: "himalayas", fetch: himalayas },
  { name: "arbeitnow", fetch: arbeitnow },
  { name: "hn", fetch: hackerNews },
];
