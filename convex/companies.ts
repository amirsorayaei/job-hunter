import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { atsProvider } from "./schema";
import { requireOwner } from "./lib/authz";

/**
 * The company catalog. The hourly collector reads every active company's
 * public job board (no tokens); the company agent adds new ones once a day.
 */

const MAX_FAILURES = 5;
const CATALOG_LIMIT = 3000;

const companyInput = v.object({
  name: v.string(),
  provider: atsProvider,
  slug: v.string(),
  website: v.optional(v.string()),
  note: v.optional(v.string()),
});

function cleanSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/** Every active board, for the collector. */
export const active = internalQuery({
  args: {},
  returns: v.array(
    v.object({ _id: v.id("companies"), name: v.string(), provider: atsProvider, slug: v.string() }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("companies")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(CATALOG_LIMIT);
    return rows.map((row) => ({ _id: row._id, name: row.name, provider: row.provider, slug: row.slug }));
  },
});

/** Names already in the catalog, so the company agent does not re-suggest them. */
export const knownNames = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query("companies").take(CATALOG_LIMIT);
    return rows.map((row) => `${row.name} (${row.provider}:${row.slug})`);
  },
});

/** Add boards the runner has already verified. Existing boards are left as they are. */
export const upsert = internalMutation({
  args: {
    companies: v.array(companyInput),
    addedBy: v.union(v.literal("seed"), v.literal("agent"), v.literal("owner")),
    now: v.number(),
  },
  returns: v.object({ inserted: v.number(), existing: v.number() }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let existing = 0;
    for (const company of args.companies.slice(0, 200)) {
      const slug = cleanSlug(company.slug);
      if (slug === "" || company.name.trim() === "") continue;
      const found = await ctx.db
        .query("companies")
        .withIndex("by_provider_and_slug", (q) => q.eq("provider", company.provider).eq("slug", slug))
        .unique();
      if (found !== null) {
        existing++;
        continue;
      }
      await ctx.db.insert("companies", {
        name: company.name.trim().slice(0, 120),
        provider: company.provider,
        slug,
        website: company.website,
        note: company.note?.slice(0, 300),
        addedBy: args.addedBy,
        active: true,
        addedAt: args.now,
        failures: 0,
      });
      inserted++;
    }
    return { inserted, existing };
  },
});

/** Outcome of one collector pass over the boards. */
export const recordChecks = internalMutation({
  args: {
    results: v.array(
      v.object({ id: v.id("companies"), ok: v.boolean(), jobCount: v.optional(v.number()) }),
    ),
    now: v.number(),
  },
  returns: v.object({ deactivated: v.number() }),
  handler: async (ctx, args) => {
    let deactivated = 0;
    for (const result of args.results) {
      const row = await ctx.db.get(result.id);
      if (row === null) continue;
      if (result.ok) {
        await ctx.db.patch(row._id, {
          lastCheckedAt: args.now,
          lastJobCount: result.jobCount,
          failures: 0,
        });
      } else {
        const failures = row.failures + 1;
        const off = failures >= MAX_FAILURES;
        if (off) deactivated++;
        await ctx.db.patch(row._id, { lastCheckedAt: args.now, failures, active: !off });
      }
    }
    return { deactivated };
  },
});

const companyView = v.object({
  _id: v.id("companies"),
  name: v.string(),
  provider: atsProvider,
  slug: v.string(),
  addedBy: v.union(v.literal("seed"), v.literal("agent"), v.literal("owner")),
  active: v.boolean(),
  addedAt: v.number(),
  lastJobCount: v.optional(v.number()),
});

/** Settings page: catalog size and the newest additions. */
export const summary = query({
  args: {},
  returns: v.object({ active: v.number(), inactive: v.number(), newest: v.array(companyView) }),
  handler: async (ctx) => {
    await requireOwner(ctx);
    const rows = await ctx.db.query("companies").order("desc").take(CATALOG_LIMIT);
    const view = (row: (typeof rows)[number]) => ({
      _id: row._id,
      name: row.name,
      provider: row.provider,
      slug: row.slug,
      addedBy: row.addedBy,
      active: row.active,
      addedAt: row.addedAt,
      lastJobCount: row.lastJobCount,
    });
    return {
      active: rows.filter((row) => row.active).length,
      inactive: rows.filter((row) => !row.active).length,
      newest: rows.slice(0, 12).map(view),
    };
  },
});

/** Turn a board back on (or off) from Settings. */
export const setActive = mutation({
  args: { companyId: v.id("companies"), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const row = await ctx.db.get(args.companyId);
    if (row === null) throw new Error("Company not found");
    await ctx.db.patch(row._id, { active: args.active, failures: 0 });
    return null;
  },
});
