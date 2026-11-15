/**
 * Built-in ATS adapters.
 *
 * Spec section 9: Greenhouse, Lever (incl. EU/global variants), Ashby,
 * SmartRecruiters, Recruitee, Workable, and Personio.
 *
 * Every `parse` is total — it returns a `failed` result rather than throwing,
 * because a thrown parser would otherwise look like an empty board and close
 * live jobs. Malformed individual items are counted and skipped; a payload
 * whose whole shape is unrecognizable is reported as schema drift.
 */

import {
  htmlToText,
  inferWorkplaceType,
  parseLocationString,
  schemaDrift,
  type AtsAdapter,
  type AtsProvider,
  type NormalizedJob,
  type ParseResult,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Build a successful result from parsed jobs. */
function ok(jobs: NormalizedJob[], malformed: number, nextCursor?: string): ParseResult {
  return {
    jobs,
    result: {
      // A complete listing with zero jobs is an authoritative empty board —
      // the only shape that may eventually close jobs (spec 7.3).
      outcome: nextCursor === undefined ? "complete" : "partial",
      authoritativeEmpty: jobs.length === 0 && malformed === 0 && nextCursor === undefined,
      termination: nextCursor === undefined ? "end of listing" : "page boundary",
      nextCursor,
      rawItemCount: jobs.length + malformed,
      malformedItemCount: malformed,
    },
  };
}

// ── Greenhouse ──────────────────────────────────────────────────────────────

export const greenhouse: AtsAdapter = {
  provider: "greenhouse",
  distinguishesUnknownBoard: true,
  listUrl: (slug) =>
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  parse(raw, ctx) {
    if (!isRecord(raw) || !Array.isArray(raw.jobs)) return schemaDrift("missing jobs array");

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    for (const item of raw.jobs) {
      if (!isRecord(item)) { malformed++; continue; }

      const id = item.id === undefined ? null : String(item.id);
      const title = str(item.title);
      const url = str(item.absolute_url);
      if (title === null || url === null) { malformed++; continue; }

      const locationName = isRecord(item.location) ? str(item.location.name) : str(item.location);
      const html = str(item.content);

      jobs.push({
        externalId: id,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: url,
        descriptionText: htmlToText(html),
        descriptionHtml: html,
        locations: parseLocationString(locationName),
        // Location only: Greenhouse JDs mention "remote" in benefits and team
        // blurbs, which made on-site roles look remote.
        workplaceType: inferWorkplaceType(locationName),
        employmentType: null,
        postedAt: str(item.updated_at) ?? str(item.first_published),
        stableLocator: `greenhouse:${ctx.slug}:${id ?? url}`,
      });
    }

    return ok(jobs, malformed);
  },
};

// ── Lever ───────────────────────────────────────────────────────────────────

export const lever: AtsAdapter = {
  provider: "lever",
  distinguishesUnknownBoard: true,
  listUrl: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  parse(raw, ctx) {
    // Lever returns a bare array. EU/global variants share the shape.
    if (!Array.isArray(raw)) return schemaDrift("expected a top-level array");

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    for (const item of raw) {
      if (!isRecord(item)) { malformed++; continue; }

      const id = str(item.id);
      const title = str(item.text);
      const url = str(item.hostedUrl);
      if (title === null || url === null) { malformed++; continue; }

      const categories = isRecord(item.categories) ? item.categories : {};
      const locationName = str(categories.location);
      const commitment = str(categories.commitment);
      const html = str(item.descriptionPlain) ?? str(item.description);

      jobs.push({
        externalId: id,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: str(item.applyUrl) ?? `${url}/apply`,
        descriptionText: htmlToText(html) ?? str(item.descriptionPlain),
        descriptionHtml: str(item.description),
        locations: parseLocationString(locationName),
        workplaceType: inferWorkplaceType(
          `${locationName ?? ""} ${str(categories.workplaceType) ?? ""}`,
        ),
        employmentType: commitment,
        postedAt:
          typeof item.createdAt === "number"
            ? new Date(item.createdAt).toISOString()
            : null,
        stableLocator: `lever:${ctx.slug}:${id ?? url}`,
      });
    }

    return ok(jobs, malformed);
  },
};

// ── Ashby ───────────────────────────────────────────────────────────────────

export const ashby: AtsAdapter = {
  provider: "ashby",
  distinguishesUnknownBoard: true,
  listUrl: (slug) =>
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`,
  parse(raw, ctx) {
    if (!isRecord(raw) || !Array.isArray(raw.jobs)) return schemaDrift("missing jobs array");

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    for (const item of raw.jobs) {
      if (!isRecord(item)) { malformed++; continue; }

      const id = str(item.id);
      const title = str(item.title);
      const url = str(item.jobUrl);
      if (title === null || url === null) { malformed++; continue; }

      const locationName = str(item.location);
      const html = str(item.descriptionHtml);

      jobs.push({
        externalId: id,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: str(item.applyUrl) ?? url,
        descriptionText: htmlToText(html) ?? str(item.descriptionPlain),
        descriptionHtml: html,
        locations: parseLocationString(locationName),
        workplaceType:
          item.isRemote === true ? "remote" : inferWorkplaceType(locationName),
        employmentType: str(item.employmentType),
        postedAt: str(item.publishedAt),
        stableLocator: `ashby:${ctx.slug}:${id ?? url}`,
      });
    }

    return ok(jobs, malformed);
  },
};

// ── SmartRecruiters ─────────────────────────────────────────────────────────

const SMARTRECRUITERS_PAGE = 100;

export const smartrecruiters: AtsAdapter = {
  provider: "smartrecruiters",
  // Measured: returns 200 with an empty list for ANY slug, including garbage.
  distinguishesUnknownBoard: false,
  listUrl: (slug, cursor) => {
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
    return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${SMARTRECRUITERS_PAGE}&offset=${offset}`;
  },
  parse(raw, ctx) {
    if (!isRecord(raw) || !Array.isArray(raw.content)) {
      return schemaDrift("missing content array");
    }

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    for (const item of raw.content) {
      if (!isRecord(item)) { malformed++; continue; }

      const id = str(item.id);
      const title = str(item.name);
      if (id === null || title === null) { malformed++; continue; }

      const location = isRecord(item.location) ? item.location : {};
      const url = str(item.ref) ?? `https://jobs.smartrecruiters.com/${ctx.slug}/${id}`;

      jobs.push({
        externalId: id,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: url,
        descriptionText: null,
        descriptionHtml: null,
        locations: [
          {
            city: str(location.city) ?? undefined,
            region: str(location.region) ?? undefined,
            country: str(location.country) ?? undefined,
          },
        ].filter((l) => l.city || l.region || l.country),
        workplaceType:
          location.remote === true
            ? "remote"
            : inferWorkplaceType(str(location.city) ?? ""),
        employmentType: isRecord(item.typeOfEmployment)
          ? str(item.typeOfEmployment.label)
          : null,
        postedAt: str(item.releasedDate),
        stableLocator: `smartrecruiters:${ctx.slug}:${id}`,
      });
    }

    // Offset pagination: another page exists only if this one was full.
    const offset = typeof raw.offset === "number" ? raw.offset : 0;
    const total = typeof raw.totalFound === "number" ? raw.totalFound : jobs.length;
    const nextOffset = offset + raw.content.length;
    const nextCursor = nextOffset < total ? String(nextOffset) : undefined;

    return ok(jobs, malformed, nextCursor);
  },
};

// ── Recruitee ───────────────────────────────────────────────────────────────

export const recruitee: AtsAdapter = {
  provider: "recruitee",
  distinguishesUnknownBoard: true,
  listUrl: (slug) => `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
  parse(raw, ctx) {
    if (!isRecord(raw) || !Array.isArray(raw.offers)) return schemaDrift("missing offers array");

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    for (const item of raw.offers) {
      if (!isRecord(item)) { malformed++; continue; }

      const id = item.id === undefined ? null : String(item.id);
      const title = str(item.title);
      const url = str(item.careers_url) ?? str(item.careers_apply_url);
      if (title === null || url === null) { malformed++; continue; }

      const html = str(item.description);
      const locationName = [str(item.city), str(item.country)].filter(Boolean).join(", ");

      jobs.push({
        externalId: id,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: str(item.careers_apply_url) ?? url,
        descriptionText: htmlToText(html),
        descriptionHtml: html,
        locations: parseLocationString(locationName),
        workplaceType: item.remote === true ? "remote" : inferWorkplaceType(locationName),
        employmentType: str(item.employment_type_code) ?? str(item.category_code),
        postedAt: str(item.published_at) ?? str(item.created_at),
        stableLocator: `recruitee:${ctx.slug}:${id ?? url}`,
      });
    }

    return ok(jobs, malformed);
  },
};

// ── Workable ────────────────────────────────────────────────────────────────

export const workable: AtsAdapter = {
  provider: "workable",
  distinguishesUnknownBoard: true,
  listUrl: (slug) =>
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
  parse(raw, ctx) {
    if (!isRecord(raw) || !Array.isArray(raw.jobs)) return schemaDrift("missing jobs array");

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    for (const item of raw.jobs) {
      if (!isRecord(item)) { malformed++; continue; }

      const shortcode = str(item.shortcode);
      const title = str(item.title);
      const url = str(item.url) ?? str(item.application_url);
      if (title === null || url === null) { malformed++; continue; }

      const locationName = [str(item.city), str(item.country)].filter(Boolean).join(", ");
      const html = str(item.description);

      jobs.push({
        externalId: shortcode,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: str(item.application_url) ?? url,
        descriptionText: htmlToText(html),
        descriptionHtml: html,
        locations: parseLocationString(locationName),
        workplaceType: item.telecommuting === true ? "remote" : inferWorkplaceType(locationName),
        employmentType: str(item.employment_type),
        postedAt: str(item.published_on) ?? str(item.created_at),
        stableLocator: `workable:${ctx.slug}:${shortcode ?? url}`,
      });
    }

    return ok(jobs, malformed);
  },
};

// ── Personio ────────────────────────────────────────────────────────────────

/**
 * Personio publishes XML, not JSON.
 *
 * A dependency-free extraction rather than a real XML parser: the feed shape is
 * flat and stable, and pulling in a parser for one adapter is not worth it. If
 * the expected wrapper element is absent, this reports schema drift rather than
 * an empty board — the distinction that keeps live jobs from being closed.
 */
export const personio: AtsAdapter = {
  provider: "personio",
  distinguishesUnknownBoard: true,
  listUrl: (slug) => `https://${encodeURIComponent(slug)}.jobs.personio.de/xml`,
  parse(raw, ctx) {
    if (typeof raw !== "string") return schemaDrift("expected XML string");
    if (!raw.includes("<workzag-jobs") && !raw.includes("<position")) {
      return schemaDrift("no <workzag-jobs> or <position> elements");
    }

    const jobs: NormalizedJob[] = [];
    let malformed = 0;

    const positions = raw.match(/<position\b[\s\S]*?<\/position>/g) ?? [];

    for (const block of positions) {
      const id = tag(block, "id");
      const title = tag(block, "name");
      if (title === null) { malformed++; continue; }

      const office = tag(block, "office");
      const description = tag(block, "jobDescriptions") ?? tag(block, "description");
      const url =
        tag(block, "url") ??
        `https://${ctx.slug}.jobs.personio.de/job/${id ?? ""}`;

      jobs.push({
        externalId: id,
        companyName: ctx.companyName,
        title,
        canonicalUrl: url,
        applyUrl: url,
        descriptionText: htmlToText(description),
        descriptionHtml: description,
        locations: parseLocationString(office),
        workplaceType: inferWorkplaceType(`${office ?? ""} ${tag(block, "schedule") ?? ""}`),
        employmentType: tag(block, "employmentType"),
        postedAt: tag(block, "createdAt"),
        stableLocator: `personio:${ctx.slug}:${id ?? url}`,
      });
    }

    return ok(jobs, malformed);
  },
};

/** Read a single XML tag's text, unwrapping CDATA. */
function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  if (match === null) return null;
  const value = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
  return value.length > 0 ? value : null;
}

export const ADAPTERS: Record<AtsProvider, AtsAdapter> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  recruitee,
  workable,
  personio,
};

export function adapterFor(provider: AtsProvider): AtsAdapter {
  return ADAPTERS[provider];
}
