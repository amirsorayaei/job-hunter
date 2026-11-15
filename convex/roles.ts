import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { applyKind, stage, track, workMode } from "./schema";
import { requireOwner } from "./lib/authz";
import { loadSettings } from "./settings";
import { DAY_MS, istanbulDate, istanbulDayStart } from "../src/lib/time";
import { buildCatalogue } from "../src/lib/tailoring/catalogue";
import { validateOutreachText } from "../src/lib/tailoring/validate";
import { isEmailAddress } from "../src/lib/gmail/classify";

/**
 * Roles: everything worth showing, from "found" to an outcome.
 *
 * Who moves a role:
 *   agents      ingest (new), prep (preparing → ready)
 *   Gmail sync  ready → applied (email seen sent), → replied, → no_response
 *   owner       prepare, dismiss, "Applied" for form roles, interview/offer/rejected
 */

const MAX_ATTEMPTS = 3;
const PREP_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const LIST_LIMIT = 2000;

// ── Agent side ─────────────────────────────────────────────────────────────

export const findingInput = v.object({
  key: v.string(),
  company: v.string(),
  title: v.string(),
  url: v.string(),
  source: v.string(),
  score: v.number(),
  workMode,
  remoteWording: v.string(),
  whyFit: v.string(),
  gaps: v.string(),
  mustHaves: v.array(v.string()),
  applyEmail: v.optional(v.string()),
  applyEmailSource: v.optional(v.string()),
  knownCompany: v.optional(v.boolean()),
});

/** Queue the best new roles for automatic prep, within today's cap. */
async function autoQueue(ctx: MutationCtx, now: number): Promise<number> {
  const settings = await loadSettings(ctx);
  if (settings.paused || settings.dailyPrepCap <= 0) return 0;

  const dayStart = istanbulDayStart(now);
  let usedToday = 0;
  for (const state of ["queued", "working", "done", "failed"] as const) {
    const rows = await ctx.db
      .query("roles")
      .withIndex("by_prep_state_and_prep_queued_at", (q) =>
        q.eq("prepState", state).gte("prepQueuedAt", dayStart),
      )
      .take(200);
    usedToday += rows.filter((row) => row.prepAuto === true).length;
  }
  let room = settings.dailyPrepCap - usedToday;
  if (room <= 0) return 0;

  const candidates = await ctx.db
    .query("roles")
    .withIndex("by_stage_and_score", (q) =>
      q.eq("stage", "new").gte("score", settings.autoPrepareMinScore),
    )
    .order("desc")
    .take(50);
  let queued = 0;
  for (const role of candidates) {
    if (room <= 0) break;
    if (role.prepState !== "none") continue;
    if (settings.autoPrepareEmailOnly && role.applyKind !== "email") continue;
    await queuePrep(ctx, role, now, true);
    room--;
    queued++;
  }
  return queued;
}

async function queuePrep(ctx: MutationCtx, role: Doc<"roles">, now: number, auto: boolean): Promise<void> {
  await ctx.db.patch(role._id, {
    stage: "preparing",
    stageChangedAt: now,
    prepState: "queued",
    prepAuto: auto,
    prepQueuedAt: now,
    prepClaimedAt: undefined,
    prepAttempts: 0,
    prepError: undefined,
  });
}

/** A scoring agent's results. Postings below the show threshold never become roles. */
export const ingest = internalMutation({
  args: { track, findings: v.array(findingInput), now: v.number() },
  returns: v.object({ inserted: v.number(), duplicates: v.number(), hidden: v.number(), autoQueued: v.number() }),
  handler: async (ctx, args) => {
    const settings = await loadSettings(ctx);
    let inserted = 0;
    let duplicates = 0;
    let hidden = 0;
    for (const finding of args.findings.slice(0, 100)) {
      if (finding.score < settings.minScoreToShow) {
        hidden++;
        continue;
      }
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", finding.key))
        .first();
      if (existing !== null) {
        duplicates++;
        continue;
      }
      const email =
        finding.applyEmail !== undefined && isEmailAddress(finding.applyEmail)
          ? finding.applyEmail.trim().toLowerCase()
          : undefined;
      await ctx.db.insert("roles", {
        key: finding.key,
        track: args.track,
        company: finding.company.slice(0, 120),
        title: finding.title.slice(0, 200),
        url: finding.url,
        source: finding.source.slice(0, 80),
        score: Math.max(0, Math.min(100, Math.round(finding.score))),
        workMode: finding.workMode,
        remoteWording: finding.remoteWording.slice(0, 300),
        whyFit: finding.whyFit.slice(0, 800),
        gaps: finding.gaps.slice(0, 600),
        mustHaves: finding.mustHaves.slice(0, 12).map((item) => item.slice(0, 80)),
        applyKind: email !== undefined ? "email" : "form",
        applyEmail: email,
        applyEmailSource: email !== undefined ? finding.applyEmailSource : undefined,
        knownCompany: finding.knownCompany,
        foundAt: args.now,
        stage: "new",
        stageChangedAt: args.now,
        prepState: "none",
        prepAttempts: 0,
      });
      inserted++;
    }
    const autoQueued = await autoQueue(ctx, args.now);
    return { inserted, duplicates, hidden, autoQueued };
  },
});

const prepJob = v.object({
  roleId: v.id("roles"),
  track,
  company: v.string(),
  title: v.string(),
  url: v.string(),
  applyKind,
  applyEmail: v.optional(v.string()),
  remoteWording: v.string(),
  whyFit: v.string(),
  gaps: v.string(),
  mustHaves: v.array(v.string()),
});

/** Next queued prep (or one stuck in "working" for over 2h). */
export const claimPrep = internalMutation({
  args: { now: v.number() },
  returns: v.union(v.null(), prepJob),
  handler: async (ctx, args) => {
    const settings = await loadSettings(ctx);
    if (settings.paused) return null;

    // Pick up roles that became eligible without a new ingest (for example
    // after the owner lowered the auto-prepare score in Settings).
    await autoQueue(ctx, args.now);

    let role = await ctx.db
      .query("roles")
      .withIndex("by_prep_state_and_prep_queued_at", (q) => q.eq("prepState", "queued"))
      .first();
    if (role === null) {
      const working = await ctx.db
        .query("roles")
        .withIndex("by_prep_state_and_prep_queued_at", (q) => q.eq("prepState", "working"))
        .take(20);
      role = working.find((row) => args.now - (row.prepClaimedAt ?? 0) > PREP_CLAIM_TTL_MS) ?? null;
    }
    if (role === null) return null;

    await ctx.db.patch(role._id, {
      prepState: "working",
      prepClaimedAt: args.now,
      prepAttempts: role.prepAttempts + 1,
    });
    return {
      roleId: role._id,
      track: role.track,
      company: role.company,
      title: role.title,
      url: role.url,
      applyKind: role.applyKind,
      applyEmail: role.applyEmail,
      remoteWording: role.remoteWording,
      whyFit: role.whyFit,
      gaps: role.gaps,
      mustHaves: role.mustHaves,
    };
  },
});

/**
 * Which validator findings should hold an EMAIL (not a resume).
 *
 * Emails are free prose that naturally names the employer's own products
 * ("Marker Method"), so an unknown capitalized word is not evidence of a lie.
 * What does hold an email: a number not in the evidence ledger, inflated
 * seniority, and a skill Candidate does not have. A gap named honestly ("I haven't
 * used AWS in production") is the one allowed mention of a missing skill.
 */
const NEGATION = /\b(not|no|never|haven'?t|hasn'?t|didn'?t|don'?t|without|limited|less|new to|learning|gap|lack)\b/i;

export function emailBlockers(
  body: string,
  violations: Array<{ kind: string; detail: string; offending?: string }>,
): Array<{ kind: string; detail: string; offending?: string }> {
  const sentences = body.split(/(?<=[.!?])\s+|\n+/);
  return violations.filter((item) => {
    if (item.kind === "unsupported_metric" || item.kind === "seniority_inflation") return true;
    if (item.kind !== "unsupported_technology" || !item.detail.includes("confirmed gap")) return false;
    const term = (item.offending ?? "").toLowerCase();
    const sentence = sentences.find((line) => line.toLowerCase().includes(term)) ?? "";
    return !NEGATION.test(sentence);
  });
}

function violationsText(violations: Array<{ detail: string }>): string {
  return `The truthfulness check stopped this email: ${violations
    .slice(0, 4)
    .map((item) => item.detail)
    .join("; ")}`;
}

/** Prep finished on the Mac. Creates the Gmail draft when there is a verified recipient. */
export const completePrep = internalMutation({
  args: {
    roleId: v.id("roles"),
    storageId: v.id("_storage"),
    filename: v.string(),
    folder: v.string(),
    summary: v.string(),
    email: v.optional(
      v.object({ to: v.string(), source: v.string(), subject: v.string(), body: v.string() }),
    ),
    now: v.number(),
  },
  returns: v.object({ drafted: v.boolean(), emailError: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.roleId);
    if (role === null) throw new Error("Role not found");
    if (role.resumeStorageId !== undefined && role.resumeStorageId !== args.storageId) {
      await ctx.storage.delete(role.resumeStorageId);
    }

    const patch: Partial<Doc<"roles">> = {
      prepState: "done",
      prepError: undefined,
      prepSummary: args.summary.slice(0, 3000),
      resumeStorageId: args.storageId,
      resumeFilename: args.filename,
      folder: args.folder,
      stage: role.stage === "preparing" || role.stage === "new" ? "ready" : role.stage,
      stageChangedAt: args.now,
    };

    let emailError: string | undefined;
    let drafted = false;
    if (args.email !== undefined) {
      if (!isEmailAddress(args.email.to)) {
        emailError = "The recipient address is not a valid email";
      } else {
        const result = validateOutreachText(
          { subject: args.email.subject, body: args.email.body, factIds: [] },
          buildCatalogue(),
          [role.company, role.title],
        );
        patch.applyKind = "email";
        patch.applyEmail = args.email.to.trim().toLowerCase();
        patch.applyEmailSource = args.email.source;
        patch.emailSubject = args.email.subject.slice(0, 200);
        patch.emailBody = args.email.body.slice(0, 5000);
        const blockers = emailBlockers(args.email.body, result.violations);
        if (blockers.length > 0) emailError = violationsText(blockers);
      }
    } else {
      patch.applyKind = "form";
    }
    patch.emailError = emailError;

    await ctx.db.patch(role._id, patch);
    if (args.email !== undefined && emailError === undefined) {
      await ctx.scheduler.runAfter(0, internal.gmail.node.createDraft, { roleId: role._id });
      drafted = true;
    }
    return { drafted, emailError };
  },
});

export const failPrep = internalMutation({
  args: { roleId: v.id("roles"), error: v.string(), final: v.boolean(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.roleId);
    if (role === null) return null;
    const retry = !args.final && role.prepAttempts < MAX_ATTEMPTS;
    await ctx.db.patch(role._id, {
      prepState: retry ? "queued" : "failed",
      prepError: args.error.slice(0, 1000),
      ...(retry ? {} : { stage: "new" as const, stageChangedAt: args.now }),
    });
    return null;
  },
});

// ── Owner side ─────────────────────────────────────────────────────────────

async function ownedRole(ctx: MutationCtx, roleId: Id<"roles">): Promise<Doc<"roles">> {
  await requireOwner(ctx);
  const role = await ctx.db.get(roleId);
  if (role === null) throw new Error("Role not found");
  return role;
}

/** "Prepare": tailor the resume and, if a recipient was found, draft the email. */
export const prepare = mutation({
  args: { roleId: v.id("roles"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ownedRole(ctx, args.roleId);
    if (role.prepState === "queued" || role.prepState === "working") return null;
    await queuePrep(ctx, role, args.now, false);
    return null;
  },
});

export const dismiss = mutation({
  args: { roleId: v.id("roles"), reason: v.optional(v.string()), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ownedRole(ctx, args.roleId);
    await ctx.db.patch(role._id, {
      stage: "dismissed",
      stageChangedAt: args.now,
      dismissReason: args.reason?.trim().slice(0, 80) || undefined,
      ...(role.prepState === "queued" ? { prepState: "none" as const } : {}),
    });
    return null;
  },
});

export const restore = mutation({
  args: { roleId: v.id("roles"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ownedRole(ctx, args.roleId);
    const back = role.resumeStorageId !== undefined ? "ready" : "new";
    await ctx.db.patch(role._id, { stage: back, stageChangedAt: args.now, dismissReason: undefined });
    return null;
  },
});

const ownerStage = v.union(
  v.literal("new"),
  v.literal("ready"),
  v.literal("applied"),
  v.literal("replied"),
  v.literal("interview"),
  v.literal("offer"),
  v.literal("rejected"),
  v.literal("no_response"),
);

/** Move a role by hand, e.g. "Applied" after a form, or "Interview" after a call. */
export const setStage = mutation({
  args: { roleId: v.id("roles"), stage: ownerStage, now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ownedRole(ctx, args.roleId);
    const patch: Partial<Doc<"roles">> = { stage: args.stage, stageChangedAt: args.now };
    if (args.stage === "applied" && role.appliedAt === undefined) patch.appliedAt = args.now;
    if (args.stage === "replied" && role.repliedAt === undefined) patch.repliedAt = args.now;
    if (args.stage === "interview") {
      if (role.interviewAt === undefined) patch.interviewAt = args.now;
      if (role.repliedAt === undefined) patch.repliedAt = args.now;
    }
    if (args.stage === "offer" || args.stage === "rejected" || args.stage === "no_response") {
      patch.closedAt = args.now;
    }
    if (args.stage === "new" || args.stage === "ready") {
      patch.appliedAt = undefined;
      patch.closedAt = undefined;
    }
    await ctx.db.patch(role._id, patch);
    return null;
  },
});

export const saveNote = mutation({
  args: { roleId: v.id("roles"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ownedRole(ctx, args.roleId);
    await ctx.db.patch(role._id, { note: args.note.slice(0, 2000) });
    return null;
  },
});

/** Owner override: create the Gmail draft even though the truthfulness check objected. */
export const draftAnyway = mutation({
  args: { roleId: v.id("roles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ownedRole(ctx, args.roleId);
    if (role.applyEmail === undefined || role.emailBody === undefined) {
      throw new Error("This role has no email to draft");
    }
    if (role.gmailDraftId !== undefined || role.sentAt !== undefined) return null;
    await ctx.db.patch(role._id, { emailError: undefined });
    await ctx.scheduler.runAfter(0, internal.gmail.node.createDraft, { roleId: role._id });
    return null;
  },
});

// ── Reads ──────────────────────────────────────────────────────────────────

const listItem = v.object({
  _id: v.id("roles"),
  track,
  company: v.string(),
  title: v.string(),
  url: v.string(),
  source: v.string(),
  score: v.number(),
  workMode,
  remoteWording: v.string(),
  applyKind,
  applyEmail: v.optional(v.string()),
  foundAt: v.number(),
  stage,
  stageChangedAt: v.number(),
  prepState: v.string(),
  prepError: v.optional(v.string()),
  hasResume: v.boolean(),
  hasDraft: v.boolean(),
  scheduledInGmail: v.optional(v.boolean()),
  scheduledFor: v.optional(v.number()),
  emailError: v.optional(v.string()),
  sentAt: v.optional(v.number()),
  followUpDraftedAt: v.optional(v.number()),
  followUpSentAt: v.optional(v.number()),
  appliedAt: v.optional(v.number()),
  repliedAt: v.optional(v.number()),
  bounced: v.optional(v.boolean()),
  knownCompany: v.optional(v.boolean()),
  dismissReason: v.optional(v.string()),
});

function toListItem(role: Doc<"roles">) {
  return {
    _id: role._id,
    track: role.track,
    company: role.company,
    title: role.title,
    url: role.url,
    source: role.source,
    score: role.score,
    workMode: role.workMode,
    remoteWording: role.remoteWording,
    applyKind: role.applyKind,
    applyEmail: role.applyEmail,
    foundAt: role.foundAt,
    stage: role.stage,
    stageChangedAt: role.stageChangedAt,
    prepState: role.prepState,
    prepError: role.prepError,
    hasResume: role.resumeStorageId !== undefined,
    hasDraft: role.gmailDraftId !== undefined,
    scheduledInGmail: role.scheduledInGmail,
    scheduledFor: role.scheduledFor,
    emailError: role.emailError,
    sentAt: role.sentAt,
    followUpDraftedAt: role.followUpDraftedAt,
    followUpSentAt: role.followUpSentAt,
    appliedAt: role.appliedAt,
    repliedAt: role.repliedAt,
    bounced: role.bounced,
    knownCompany: role.knownCompany,
    dismissReason: role.dismissReason,
  };
}

/** Every role, newest first, for the tables (filtering happens in the browser). */
export const list = query({
  args: {},
  returns: v.array(listItem),
  handler: async (ctx) => {
    await requireOwner(ctx);
    const rows = await ctx.db.query("roles").withIndex("by_found_at").order("desc").take(LIST_LIMIT);
    return rows.map(toListItem);
  },
});

/** One role with everything, for the detail panel. */
export const get = query({
  args: { roleId: v.id("roles") },
  returns: v.union(
    v.null(),
    v.object({
      role: listItem,
      whyFit: v.string(),
      gaps: v.string(),
      mustHaves: v.array(v.string()),
      applyEmailSource: v.optional(v.string()),
      prepSummary: v.optional(v.string()),
      resumeUrl: v.optional(v.string()),
      resumeFilename: v.optional(v.string()),
      folder: v.optional(v.string()),
      emailSubject: v.optional(v.string()),
      emailBody: v.optional(v.string()),
      draftedAt: v.optional(v.number()),
      interviewAt: v.optional(v.number()),
      closedAt: v.optional(v.number()),
      lastReplyFrom: v.optional(v.string()),
      lastReplySnippet: v.optional(v.string()),
      note: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const role = await ctx.db.get(args.roleId);
    if (role === null) return null;
    const resumeUrl =
      role.resumeStorageId !== undefined ? ((await ctx.storage.getUrl(role.resumeStorageId)) ?? undefined) : undefined;
    return {
      role: toListItem(role),
      whyFit: role.whyFit,
      gaps: role.gaps,
      mustHaves: role.mustHaves,
      applyEmailSource: role.applyEmailSource,
      prepSummary: role.prepSummary,
      resumeUrl,
      resumeFilename: role.resumeFilename,
      folder: role.folder,
      emailSubject: role.emailSubject,
      emailBody: role.emailBody,
      draftedAt: role.draftedAt,
      interviewAt: role.interviewAt,
      closedAt: role.closedAt,
      lastReplyFrom: role.lastReplyFrom,
      lastReplySnippet: role.lastReplySnippet,
      note: role.note,
    };
  },
});

const countsShape = v.object({
  found: v.number(),
  prepared: v.number(),
  applied: v.number(),
  replied: v.number(),
  interview: v.number(),
  offer: v.number(),
  rejected: v.number(),
  noResponse: v.number(),
  waiting: v.number(),
});

/**
 * Dashboard numbers. `since` limits each count to events inside the period
 * (found by foundAt, applied by appliedAt, and so on); `now` drives the daily
 * series and the attention list.
 */
export const stats = query({
  args: { since: v.optional(v.number()), now: v.number(), days: v.number() },
  returns: v.object({
    counts: countsShape,
    attention: v.object({
      newRoles: v.number(),
      preparing: v.number(),
      draftsInGmail: v.number(),
      scheduledInGmail: v.number(),
      formsToApply: v.number(),
      followUpsInGmail: v.number(),
      failedPreps: v.number(),
      blockedEmails: v.number(),
    }),
    daily: v.array(
      v.object({ date: v.string(), found: v.number(), applied: v.number(), replied: v.number() }),
    ),
    stages: v.array(v.object({ stage: v.string(), count: v.number() })),
    byTrack: v.array(
      v.object({ track, applied: v.number(), replied: v.number(), interview: v.number() }),
    ),
    byChannel: v.array(v.object({ channel: applyKind, applied: v.number(), replied: v.number() })),
    /** Roles found in the period, counted at the furthest step each reached. */
    funnel: v.array(v.object({ step: v.string(), count: v.number() })),
    firstAppliedAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const rows = await ctx.db.query("roles").withIndex("by_found_at").order("desc").take(5000);
    const since = args.since ?? 0;
    const inPeriod = (ms: number | undefined) => ms !== undefined && ms >= since;

    const counts = {
      found: 0, prepared: 0, applied: 0, replied: 0, interview: 0,
      offer: 0, rejected: 0, noResponse: 0, waiting: 0,
    };
    const attention = {
      newRoles: 0, preparing: 0, draftsInGmail: 0, scheduledInGmail: 0, formsToApply: 0,
      followUpsInGmail: 0, failedPreps: 0, blockedEmails: 0,
    };
    const stageCounts = new Map<string, number>();
    const trackStats = new Map<"frontend" | "fullstack", { applied: number; replied: number; interview: number }>([
      ["frontend", { applied: 0, replied: 0, interview: 0 }],
      ["fullstack", { applied: 0, replied: 0, interview: 0 }],
    ]);
    const channelStats = new Map<"email" | "form", { applied: number; replied: number }>([
      ["email", { applied: 0, replied: 0 }],
      ["form", { applied: 0, replied: 0 }],
    ]);

    const days = Math.max(7, Math.min(120, Math.round(args.days)));
    const firstDay = istanbulDayStart(args.now) - (days - 1) * DAY_MS;
    const daily = new Map<string, { found: number; applied: number; replied: number }>();
    for (let i = 0; i < days; i++) {
      daily.set(istanbulDate(firstDay + i * DAY_MS + DAY_MS / 2), { found: 0, applied: 0, replied: 0 });
    }
    const bump = (ms: number | undefined, field: "found" | "applied" | "replied") => {
      if (ms === undefined || ms < firstDay) return;
      const bucket = daily.get(istanbulDate(ms));
      if (bucket !== undefined) bucket[field]++;
    };

    const FUNNEL_STEPS = ["Found", "Prepared", "Applied", "Replied", "Interview", "Offer"];
    const reached = [0, 0, 0, 0, 0, 0];
    const levelOf = (role: Doc<"roles">): number => {
      if (role.stage === "offer") return 5;
      if (role.stage === "interview" || role.interviewAt !== undefined) return 4;
      if (role.repliedAt !== undefined || role.stage === "replied") return 3;
      if (role.appliedAt !== undefined || role.stage === "applied" || role.stage === "rejected" || role.stage === "no_response") return 2;
      if (role.resumeStorageId !== undefined || role.stage === "ready") return 1;
      return 0;
    };

    let firstAppliedAt: number | undefined;
    for (const role of rows) {
      if (inPeriod(role.foundAt)) {
        const level = levelOf(role);
        for (let step = 0; step <= level; step++) reached[step]++;
      }
      const dismissed = role.stage === "dismissed";
      if (!dismissed) stageCounts.set(role.stage, (stageCounts.get(role.stage) ?? 0) + 1);

      if (inPeriod(role.foundAt)) counts.found++;
      if (inPeriod(role.foundAt) && role.resumeStorageId !== undefined) counts.prepared++;
      bump(role.foundAt, "found");

      if (role.appliedAt !== undefined) {
        if (firstAppliedAt === undefined || role.appliedAt < firstAppliedAt) firstAppliedAt = role.appliedAt;
        bump(role.appliedAt, "applied");
      }
      bump(role.repliedAt, "replied");

      if (inPeriod(role.appliedAt)) {
        counts.applied++;
        trackStats.get(role.track)!.applied++;
        channelStats.get(role.applyKind)!.applied++;
        if (role.repliedAt !== undefined) {
          trackStats.get(role.track)!.replied++;
          channelStats.get(role.applyKind)!.replied++;
        }
        if (role.interviewAt !== undefined || role.stage === "interview" || role.stage === "offer") {
          trackStats.get(role.track)!.interview++;
        }
        if (role.stage === "applied") counts.waiting++;
      }
      if (inPeriod(role.repliedAt)) counts.replied++;
      if (inPeriod(role.interviewAt) || (role.stage === "interview" && inPeriod(role.stageChangedAt))) counts.interview++;
      if (role.stage === "offer" && inPeriod(role.stageChangedAt)) counts.offer++;
      if (role.stage === "rejected" && inPeriod(role.stageChangedAt)) counts.rejected++;
      if (role.stage === "no_response" && inPeriod(role.stageChangedAt)) counts.noResponse++;

      if (role.stage === "new") attention.newRoles++;
      if (role.stage === "preparing") attention.preparing++;
      if (role.stage === "ready" && role.applyKind === "email" && role.gmailDraftId !== undefined) {
        if (role.scheduledInGmail === true) attention.scheduledInGmail++;
        else attention.draftsInGmail++;
      }
      if (role.stage === "ready" && role.applyKind === "form") attention.formsToApply++;
      if (role.stage === "ready" && role.emailError !== undefined) attention.blockedEmails++;
      if (role.stage === "applied" && role.followUpDraftedAt !== undefined && role.followUpSentAt === undefined) {
        attention.followUpsInGmail++;
      }
      if (role.prepState === "failed" && role.stage === "new") attention.failedPreps++;
    }

    const stageOrder = ["new", "preparing", "ready", "applied", "replied", "interview", "offer", "rejected", "no_response"];
    return {
      counts,
      attention,
      daily: [...daily.entries()].map(([date, value]) => ({ date, ...value })),
      stages: stageOrder.map((name) => ({ stage: name, count: stageCounts.get(name) ?? 0 })),
      byTrack: [...trackStats.entries()].map(([name, value]) => ({ track: name, ...value })),
      byChannel: [...channelStats.entries()].map(([channel, value]) => ({ channel, ...value })),
      funnel: FUNNEL_STEPS.map((step, index) => ({ step, count: reached[index] })),
      firstAppliedAt,
    };
  },
});

/** Maintenance (CLI only): delete roles by their dedupe keys, e.g. demo rows. */
export const removeByKeys = internalMutation({
  args: { keys: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let removed = 0;
    for (const key of args.keys.slice(0, 200)) {
      const rows = await ctx.db.query("roles").withIndex("by_key", (q) => q.eq("key", key)).take(5);
      for (const row of rows) {
        if (row.resumeStorageId !== undefined) await ctx.storage.delete(row.resumeStorageId);
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return removed;
  },
});
