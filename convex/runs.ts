import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { agentName, runUsage } from "./schema";
import { requireOwner } from "./lib/authz";

/** One row per agent run on the Mac, so the Settings page can show health. */

const KEEP_PER_AGENT = 40;
const AGENTS = ["collector", "frontend", "fullstack", "prep", "startups", "explore"] as const;

export const start = internalMutation({
  args: { agent: agentName, now: v.number() },
  returns: v.id("agentRuns"),
  handler: async (ctx, args) =>
    await ctx.db.insert("agentRuns", { agent: args.agent, startedAt: args.now }),
});

export const finish = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    ok: v.boolean(),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    usage: v.optional(runUsage),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null) return null;
    await ctx.db.patch(args.runId, {
      finishedAt: args.now,
      ok: args.ok,
      summary: args.summary?.slice(0, 2000),
      error: args.error?.slice(0, 2000),
      usage: args.usage,
    });
    const old = await ctx.db
      .query("agentRuns")
      .withIndex("by_agent_and_started_at", (q) => q.eq("agent", run.agent))
      .order("desc")
      .take(KEEP_PER_AGENT + 20);
    for (const stale of old.slice(KEEP_PER_AGENT)) await ctx.db.delete(stale._id);
    return null;
  },
});

const runView = v.object({
  _id: v.id("agentRuns"),
  agent: agentName,
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  ok: v.optional(v.boolean()),
  summary: v.optional(v.string()),
  error: v.optional(v.string()),
  usage: v.optional(runUsage),
});

/** Latest runs for each agent, newest first. */
export const recent = query({
  args: {},
  returns: v.array(v.object({ agent: agentName, runs: v.array(runView) })),
  handler: async (ctx) => {
    await requireOwner(ctx);
    const out = [];
    for (const agent of AGENTS) {
      const runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_agent_and_started_at", (q) => q.eq("agent", agent))
        .order("desc")
        .take(6);
      out.push({
        agent,
        runs: runs.map((run) => ({
          _id: run._id,
          agent: run.agent,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          ok: run.ok,
          summary: run.summary,
          error: run.error,
          usage: run.usage,
        })),
      });
    }
    return out;
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Claude tokens the agents spent in the last 24 hours, per agent and in total. */
export const usageLastDay = query({
  args: { now: v.number() },
  returns: v.object({
    total: runUsage,
    byAgent: v.array(v.object({ agent: agentName, runs: v.number(), usage: runUsage })),
  }),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const empty = () => ({ calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 });
    const total = empty();
    const byAgent = [];
    for (const agent of AGENTS) {
      const rows = await ctx.db
        .query("agentRuns")
        .withIndex("by_agent_and_started_at", (q) => q.eq("agent", agent).gte("startedAt", args.now - DAY_MS))
        .take(200);
      const sum = empty();
      let runs = 0;
      for (const row of rows) {
        if (row.usage === undefined) continue;
        runs++;
        for (const key of Object.keys(sum) as Array<keyof typeof sum>) {
          sum[key] += row.usage[key];
          total[key] += row.usage[key];
        }
      }
      byAgent.push({ agent, runs, usage: sum });
    }
    return { total, byAgent };
  },
});
