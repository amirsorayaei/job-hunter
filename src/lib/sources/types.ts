/**
 * Source adapter contract.
 *
 * Spec: JOB-HUNTER-IMPLEMENTATION-PLAN-V3-CONVEX-CLOUD.md section 9.
 *
 * Every adapter is split into two halves:
 *
 *   - `parse(raw)`   pure, offline-testable normalization of a payload
 *   - `request(...)` the HTTP shape, which the Convex action performs
 *
 * The split is deliberate: spec 9 requires fixture tests for pagination, empty
 * boards, malformed data, timeouts, redirects, 404, 429, 5xx, partial
 * completion, and schema drift, and states "live network is not required for
 * test success". Keeping parsing pure makes all of that testable without
 * mocking HTTP.
 */

export type SourceType =
  | "ats"
  | "feed"
  | "website_recipe"
  | "repository"
  | "search_query"
  | "manual";

export type AtsProvider =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "recruitee"
  | "workable"
  | "personio";

export interface CollectionResult {
  outcome: "complete" | "partial" | "failed" | "blocked";
  /**
   * True only when the source authoritatively returned zero jobs — an empty
   * board, not an empty response caused by an error or a schema change.
   * Absence is only evidence when this or a complete listing is trustworthy.
   */
  authoritativeEmpty: boolean;
  termination: string;
  nextCursor?: string;
  rawItemCount: number;
  malformedItemCount: number;
}

export interface NormalizedLocation {
  city?: string;
  region?: string;
  country?: string;
}

export interface NormalizedJob {
  externalId: string | null;
  companyName: string;
  title: string;
  canonicalUrl: string;
  applyUrl: string | null;
  descriptionText: string | null;
  descriptionHtml: string | null;
  locations: NormalizedLocation[];
  workplaceType: "onsite" | "hybrid" | "remote" | "unknown";
  employmentType: string | null;
  postedAt: string | null;
  /** Stable per-source locator, used as a fingerprint discriminator (spec 7.2). */
  stableLocator: string;
}

export interface ParseResult {
  jobs: NormalizedJob[];
  result: CollectionResult;
}

export interface AtsAdapter {
  provider: AtsProvider;
  /** Build the listing URL for a board slug and optional cursor. */
  listUrl(slug: string, cursor?: string): string;
  /** Normalize one raw payload. Never throws — malformed input is counted. */
  parse(raw: unknown, context: { slug: string; companyName: string }): ParseResult;
  /**
   * Whether this provider distinguishes an unknown board from an empty one.
   *
   * MEASURED, not assumed. SmartRecruiters answers `200 {content: [], totalFound: 0}`
   * for any slug at all, including `asdfghjkl999` — so for that provider an
   * empty response carries no information about whether the board exists.
   *
   * Two consequences:
   *  - Detection: an empty response must never confirm a board (see
   *    `scripts/probe-ats.ts`, which requires at least one job).
   *  - Liveness: for such a provider, an empty listing from a source that has
   *    never once returned a job is a misconfigured slug, not an empty board,
   *    and must not be treated as authoritative absence.
   */
  distinguishesUnknownBoard: boolean;
}

/** Infer workplace type from free text. Conservative: unknown unless clear. */
export function inferWorkplaceType(
  text: string | null | undefined,
): NormalizedJob["workplaceType"] {
  if (!text) return "unknown";
  const lower = text.toLowerCase();
  if (lower.includes("hybrid")) return "hybrid";
  if (lower.includes("remote")) return "remote";
  if (lower.includes("on-site") || lower.includes("onsite") || lower.includes("in office")) {
    return "onsite";
  }
  return "unknown";
}

/**
 * Split a free-text location string into a tuple.
 *
 * Deliberately shallow: "Amsterdam, Netherlands" -> {city, country}. Anything
 * more ambitious guesses wrong on real ATS data, and a wrong country is worse
 * than a missing one because eligibility rules read it.
 */
export function parseLocationString(value: string | null | undefined): NormalizedLocation[] {
  if (!value) return [];
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return [];

  // Some boards pack several locations into one string.
  const candidates = cleaned.split(/\s*(?:;|\||\/| or | and )\s*/i).filter(Boolean);

  return candidates.map((candidate) => {
    const parts = candidate.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return {};
    if (parts.length === 1) return { city: parts[0] };
    return { city: parts[0], country: parts[parts.length - 1] };
  });
}

/** Strip HTML to plain text without pulling in a parser dependency. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    // Inline tags are replaced by a space so words do not fuse
    // ("Build<b>things</b>" must not become "Buildthings"), which leaves a
    // stray space before punctuation: "Build things ." Clean that up, or the
    // artifact ends up in JD text that requirement extraction later reads.
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** A failed parse, expressed as a result rather than an exception. */
export function schemaDrift(reason: string): ParseResult {
  return {
    jobs: [],
    result: {
      // NOT "complete": a payload we cannot read is not an authoritative empty
      // board, and must never be allowed to close jobs.
      outcome: "failed",
      authoritativeEmpty: false,
      termination: `schema drift: ${reason}`,
      rawItemCount: 0,
      malformedItemCount: 0,
    },
  };
}
