import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { track } from "./schema";
import { DAY_MS } from "../src/lib/time";

/**
 * The queue between the collector (no tokens) and the two scoring agents.
 * A scored posting stays as a "seen" marker so it is never scored twice.
 */

const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const KEEP_SCORED_DAYS = 120;

/** Which of these dedupe keys have never been seen (as a posting or a role). */
export const unknownKeys = internalQuery({
  args: { keys: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const unknown: string[] = [];
    for (const key of [...new Set(args.keys)].slice(0, 1000)) {
      const posting = await ctx.db
        .query("postings")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (posting !== null) continue;
      const role = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (role !== null) continue;
      unknown.push(key);
    }
    return unknown;
  },
});

export const add = internalMutation({
  args: {
    postings: v.array(
      v.object({
        key: v.string(),
        track,
        company: v.string(),
        title: v.string(),
        url: v.string(),
        location: v.string(),
        source: v.string(),
        description: v.string(),
        postedAt: v.optional(v.string()),
        knownCompany: v.optional(v.boolean()),
      }),
    ),
    now: v.number(),
  },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, args) => {
    let inserted = 0;
    for (const posting of args.postings.slice(0, 300)) {
      const existing = await ctx.db
        .query("postings")
        .withIndex("by_key", (q) => q.eq("key", posting.key))
        .first();
      if (existing !== null) continue;
      await ctx.db.insert("postings", {
        ...posting,
        company: posting.company.slice(0, 120),
        title: posting.title.slice(0, 200),
        location: posting.location.slice(0, 200),
        description: posting.description.slice(0, 6000),
        state: "pending",
        foundAt: args.now,
      });
      inserted++;
    }
    return { inserted };
  },
});

const claimed = v.object({
  key: v.string(),
  company: v.string(),
  title: v.string(),
  url: v.string(),
  location: v.string(),
  source: v.string(),
  description: v.string(),
  postedAt: v.optional(v.string()),
  knownCompany: v.optional(v.boolean()),
});

/** Hand a scoring agent its next batch. A batch not finished in 2h is handed out again. */
export const claim = internalMutation({
  args: { track, limit: v.number(), now: v.number() },
  returns: v.array(claimed),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("postings")
      .withIndex("by_state_and_track", (q) => q.eq("state", "pending").eq("track", args.track))
      .take(200);
    const out = [];
    for (const row of rows) {
      if (out.length >= Math.min(args.limit, 40)) break;
      if (row.claimedAt !== undefined && args.now - row.claimedAt < CLAIM_TTL_MS) continue;
      await ctx.db.patch(row._id, { claimedAt: args.now });
      out.push({
        key: row.key,
        company: row.company,
        title: row.title,
        url: row.url,
        location: row.location,
        source: row.source,
        description: row.description,
        postedAt: row.postedAt,
        knownCompany: row.knownCompany,
      });
    }
    return out;
  },
});

export const markScored = internalMutation({
  args: { results: v.array(v.object({ key: v.string(), score: v.number() })) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const result of args.results) {
      const row = await ctx.db
        .query("postings")
        .withIndex("by_key", (q) => q.eq("key", result.key))
        .first();
      if (row === null) continue;
      await ctx.db.patch(row._id, { state: "scored", score: result.score, description: "" });
    }
    return null;
  },
});

/** Daily: forget scored postings older than KEEP_SCORED_DAYS. */
export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - KEEP_SCORED_DAYS * DAY_MS;
    const old = await ctx.db
      .query("postings")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(500);
    let removed = 0;
    for (const row of old) {
      if (row.state !== "scored") continue;
      await ctx.db.delete(row._id);
      removed++;
    }
    return removed;
  },
});

/** Pending count per track, for the status panel. */
export const pendingCounts = internalQuery({
  args: {},
  returns: v.object({ frontend: v.number(), fullstack: v.number() }),
  handler: async (ctx) => {
    const count = async (t: "frontend" | "fullstack") =>
      (
        await ctx.db
          .query("postings")
          .withIndex("by_state_and_track", (q) => q.eq("state", "pending").eq("track", t))
          .take(1000)
      ).length;
    return { frontend: await count("frontend"), fullstack: await count("fullstack") };
  },
});
