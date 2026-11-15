import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOwner } from "./lib/authz";
import { agentModel } from "./schema";

/**
 * Everything the owner tunes, in one row, editable from the Settings page.
 * The Mac agents read it at the start of every run, so a change applies from
 * their next run with no restart.
 */

export type AgentModel = "opus" | "sonnet" | "haiku";

export interface Settings {
  paused: boolean;
  autoPrepareMinScore: number;
  dailyPrepCap: number;
  minScoreToShow: number;
  scoreModel: AgentModel;
  exploreModel: AgentModel;
  companiesModel: AgentModel;
  prepModel: AgentModel;
  /** Local hours (0-23) whose scoring run also searches the open web. */
  exploreHours: number[];
  /** Quiet hours [from, to) in Mac local time, wrapping midnight. No Claude agent runs inside them. */
  quietFrom: number;
  quietTo: number;
  /** Hours between scoring runs. */
  scoreEveryHours: number;
  /** Auto-prepare only email roles; form roles wait for a Prepare click. */
  autoPrepareEmailOnly: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  autoPrepareMinScore: 70,
  dailyPrepCap: 50,
  minScoreToShow: 50,
  scoreModel: "sonnet",
  exploreModel: "sonnet",
  companiesModel: "sonnet",
  prepModel: "opus",
  exploreHours: [10, 22],
  quietFrom: 0,
  quietTo: 8,
  scoreEveryHours: 3,
  autoPrepareEmailOnly: false,
};

const settingsShape = v.object({
  paused: v.boolean(),
  autoPrepareMinScore: v.number(),
  dailyPrepCap: v.number(),
  minScoreToShow: v.number(),
  scoreModel: agentModel,
  exploreModel: agentModel,
  companiesModel: agentModel,
  prepModel: agentModel,
  exploreHours: v.array(v.number()),
  quietFrom: v.number(),
  quietTo: v.number(),
  scoreEveryHours: v.number(),
  autoPrepareEmailOnly: v.boolean(),
});

export async function loadSettings(ctx: QueryCtx | MutationCtx): Promise<Settings> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", "settings"))
    .unique();
  if (row === null) return { ...DEFAULT_SETTINGS };
  return {
    paused: row.paused,
    autoPrepareMinScore: row.autoPrepareMinScore,
    dailyPrepCap: row.dailyPrepCap,
    minScoreToShow: row.minScoreToShow,
    scoreModel: row.scoreModel ?? DEFAULT_SETTINGS.scoreModel,
    exploreModel: row.exploreModel ?? DEFAULT_SETTINGS.exploreModel,
    companiesModel: row.companiesModel ?? DEFAULT_SETTINGS.companiesModel,
    prepModel: row.prepModel ?? DEFAULT_SETTINGS.prepModel,
    exploreHours: row.exploreHours ?? DEFAULT_SETTINGS.exploreHours,
    quietFrom: row.quietFrom ?? DEFAULT_SETTINGS.quietFrom,
    quietTo: row.quietTo ?? DEFAULT_SETTINGS.quietTo,
    scoreEveryHours: row.scoreEveryHours ?? DEFAULT_SETTINGS.scoreEveryHours,
    autoPrepareEmailOnly: row.autoPrepareEmailOnly ?? DEFAULT_SETTINGS.autoPrepareEmailOnly,
  };
}

export const get = query({
  args: {},
  returns: settingsShape,
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await loadSettings(ctx);
  },
});

/** For the Mac runners. */
export const forAgents = internalQuery({
  args: {},
  returns: settingsShape,
  handler: async (ctx) => await loadSettings(ctx),
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const update = mutation({
  args: {
    paused: v.optional(v.boolean()),
    autoPrepareMinScore: v.optional(v.number()),
    dailyPrepCap: v.optional(v.number()),
    minScoreToShow: v.optional(v.number()),
    scoreModel: v.optional(agentModel),
    exploreModel: v.optional(agentModel),
    companiesModel: v.optional(agentModel),
    prepModel: v.optional(agentModel),
    exploreHours: v.optional(v.array(v.number())),
    quietFrom: v.optional(v.number()),
    quietTo: v.optional(v.number()),
    scoreEveryHours: v.optional(v.number()),
    autoPrepareEmailOnly: v.optional(v.boolean()),
    now: v.number(),
  },
  returns: settingsShape,
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const current = await loadSettings(ctx);
    const hours = args.exploreHours ?? current.exploreHours;
    const next: Settings = {
      paused: args.paused ?? current.paused,
      autoPrepareMinScore: clamp(args.autoPrepareMinScore ?? current.autoPrepareMinScore, 0, 101),
      dailyPrepCap: clamp(args.dailyPrepCap ?? current.dailyPrepCap, 0, 100),
      minScoreToShow: clamp(args.minScoreToShow ?? current.minScoreToShow, 0, 100),
      scoreModel: args.scoreModel ?? current.scoreModel,
      exploreModel: args.exploreModel ?? current.exploreModel,
      companiesModel: args.companiesModel ?? current.companiesModel,
      prepModel: args.prepModel ?? current.prepModel,
      quietFrom: clamp(args.quietFrom ?? current.quietFrom, 0, 23),
      quietTo: clamp(args.quietTo ?? current.quietTo, 0, 23),
      scoreEveryHours: clamp(args.scoreEveryHours ?? current.scoreEveryHours, 1, 24),
      autoPrepareEmailOnly: args.autoPrepareEmailOnly ?? current.autoPrepareEmailOnly,
      exploreHours: [...new Set(hours.map((hour) => clamp(hour, 0, 23)))].sort((a, b) => a - b).slice(0, 24),
    };
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "settings"))
      .unique();
    if (row === null) {
      await ctx.db.insert("settings", { key: "settings", ...next, updatedAt: args.now });
    } else {
      await ctx.db.patch(row._id, { ...next, updatedAt: args.now });
    }
    return next;
  },
});
