import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

/**
 * Job Hunter, simplified (2026-11).
 *
 * One job: find roles that fit, prepare the good ones (tailored resume, and a
 * Gmail draft when a real recipient address exists), and track what happened.
 *
 *   postings   what the hourly collector found, waiting for a track agent to
 *              score it. After scoring it stays as a "seen" marker.
 *   roles      everything worth showing: found → prepared → applied → outcome.
 *   companies  the catalog the collector reads (grown by the company agent).
 *   settings   one row: pause switch and auto-prepare rules.
 *   agentRuns  one row per agent run, for the status panel.
 *   gmail*     the Gmail connection used to create drafts and read replies.
 */

/** Claude tokens one agent run spent. costUsd is the API list price, for scale only. */
export const runUsage = v.object({
  calls: v.number(),
  inputTokens: v.number(),
  cacheReadTokens: v.number(),
  cacheWriteTokens: v.number(),
  outputTokens: v.number(),
  costUsd: v.number(),
});

export const track = v.union(v.literal("frontend"), v.literal("fullstack"));

export const workMode = v.union(
  v.literal("remote"),
  v.literal("visa"),
  v.literal("turkey"),
  v.literal("unclear"),
);

export const applyKind = v.union(v.literal("email"), v.literal("form"));

/**
 * Where a role stands.
 *
 *   new        found, waiting for a decision
 *   preparing  resume (and email) being prepared on the Mac
 *   ready      prepared: email draft is in Gmail, or form role with its resume
 *   applied    email actually sent (seen in Gmail) or form ticked as applied
 *   replied    a person answered
 *   interview  in the interview process (set by the owner)
 *   offer      offer received (set by the owner)
 *   rejected   rejected (set by the owner, or a bounce)
 *   no_response  follow-up sent and still nothing after a week
 *   dismissed  not interested
 */
export const stage = v.union(
  v.literal("new"),
  v.literal("preparing"),
  v.literal("ready"),
  v.literal("applied"),
  v.literal("replied"),
  v.literal("interview"),
  v.literal("offer"),
  v.literal("rejected"),
  v.literal("no_response"),
  v.literal("dismissed"),
);

export const prepState = v.union(
  v.literal("none"),
  v.literal("queued"),
  v.literal("working"),
  v.literal("done"),
  v.literal("failed"),
);

export const atsProvider = v.union(
  v.literal("greenhouse"),
  v.literal("lever"),
  v.literal("ashby"),
  v.literal("smartrecruiters"),
  v.literal("recruitee"),
  v.literal("workable"),
  v.literal("personio"),
);

export const agentModel = v.union(v.literal("opus"), v.literal("sonnet"), v.literal("haiku"));

export const agentName = v.union(
  v.literal("collector"),
  v.literal("frontend"),
  v.literal("fullstack"),
  v.literal("companies"),
  v.literal("prep"),
  v.literal("startups"),
  v.literal("explore"),
);

export default defineSchema({
  ...authTables,

  /** Replaces the authTables `users` table to add owner fields. */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    role: v.optional(v.literal("owner")),
    status: v.optional(v.union(v.literal("active"), v.literal("disabled"))),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  ownerBootstrap: defineTable({
    key: v.literal("owner"),
    claimedByUserId: v.id("users"),
    claimedAt: v.number(),
  }).index("by_key", ["key"]),

  settings: defineTable({
    key: v.literal("settings"),
    paused: v.boolean(),
    /** Roles scoring at least this are prepared without a click. */
    autoPrepareMinScore: v.number(),
    /** Most roles prepared automatically per Istanbul day. */
    dailyPrepCap: v.number(),
    /** Postings scoring below this are never shown. */
    minScoreToShow: v.number(),
    scoreModel: v.optional(agentModel),
    exploreModel: v.optional(agentModel),
    companiesModel: v.optional(agentModel),
    prepModel: v.optional(agentModel),
    /** Local hours whose scoring run also searches the open web. */
    exploreHours: v.optional(v.array(v.number())),
    /** Quiet hours [from, to) in Mac local time, wrapping midnight. from === to means none. */
    quietFrom: v.optional(v.number()),
    quietTo: v.optional(v.number()),
    /** Hours between scoring runs. */
    scoreEveryHours: v.optional(v.number()),
    /** Auto-prepare only roles that take applications by email; form roles wait for a Prepare click. */
    autoPrepareEmailOnly: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  companies: defineTable({
    name: v.string(),
    provider: atsProvider,
    slug: v.string(),
    website: v.optional(v.string()),
    addedBy: v.union(v.literal("seed"), v.literal("agent"), v.literal("owner")),
    active: v.boolean(),
    addedAt: v.number(),
    lastCheckedAt: v.optional(v.number()),
    lastJobCount: v.optional(v.number()),
    failures: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_provider_and_slug", ["provider", "slug"])
    .index("by_active", ["active"]),

  postings: defineTable({
    /** normUrl() of the posting, the dedupe key. */
    key: v.string(),
    track,
    company: v.string(),
    title: v.string(),
    url: v.string(),
    location: v.string(),
    source: v.string(),
    /** JD text for the scorer; cleared once scored to keep the table small. */
    description: v.string(),
    postedAt: v.optional(v.string()),
    /** Candidate already dealt with this company (different role). */
    knownCompany: v.optional(v.boolean()),
    state: v.union(v.literal("pending"), v.literal("scored")),
    foundAt: v.number(),
    claimedAt: v.optional(v.number()),
    score: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_state_and_track", ["state", "track"]),

  roles: defineTable({
    key: v.string(),
    /** Why the owner passed on it (picked from a short list). Kept so a dismissed role never comes back. */
    dismissReason: v.optional(v.string()),
    track,
    company: v.string(),
    title: v.string(),
    url: v.string(),
    source: v.string(),
    score: v.number(),
    workMode,
    /** The employer's exact geography wording, kept as a flag. */
    remoteWording: v.string(),
    whyFit: v.string(),
    gaps: v.string(),
    mustHaves: v.array(v.string()),
    applyKind,
    /** Verified recipient for email roles. */
    applyEmail: v.optional(v.string()),
    applyEmailSource: v.optional(v.string()),
    /** Candidate already applied to or contacted this company for another role. */
    knownCompany: v.optional(v.boolean()),
    foundAt: v.number(),
    stage,
    stageChangedAt: v.number(),

    // Preparation (runs on the Mac).
    prepState,
    prepAuto: v.optional(v.boolean()),
    prepQueuedAt: v.optional(v.number()),
    prepClaimedAt: v.optional(v.number()),
    prepAttempts: v.number(),
    prepError: v.optional(v.string()),
    prepSummary: v.optional(v.string()),
    resumeStorageId: v.optional(v.id("_storage")),
    resumeFilename: v.optional(v.string()),
    folder: v.optional(v.string()),

    // Email (only when applyKind is "email" and the address was verified).
    emailSubject: v.optional(v.string()),
    emailBody: v.optional(v.string()),
    emailError: v.optional(v.string()),
    gmailDraftId: v.optional(v.string()),
    gmailThreadId: v.optional(v.string()),
    gmailMessageId: v.optional(v.string()),
    draftedAt: v.optional(v.number()),
    /** Waiting in Gmail's Scheduled folder. */
    scheduledInGmail: v.optional(v.boolean()),
    scheduledFor: v.optional(v.number()),
    rfcMessageId: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    followUpDraftId: v.optional(v.string()),
    followUpDraftedAt: v.optional(v.number()),
    followUpSentAt: v.optional(v.number()),
    bounced: v.optional(v.boolean()),

    // Outcome.
    appliedAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    lastReplyFrom: v.optional(v.string()),
    lastReplySnippet: v.optional(v.string()),
    interviewAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    note: v.optional(v.string()),
  })
    .index("by_key", ["key"])
    .index("by_stage_and_score", ["stage", "score"])
    .index("by_stage_and_found_at", ["stage", "foundAt"])
    .index("by_prep_state_and_prep_queued_at", ["prepState", "prepQueuedAt"])
    .index("by_found_at", ["foundAt"])
    .index("by_applied_at", ["appliedAt"]),

  agentRuns: defineTable({
    agent: agentName,
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    ok: v.optional(v.boolean()),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    usage: v.optional(runUsage),
  }).index("by_agent_and_started_at", ["agent", "startedAt"]),

  gmailConnections: defineTable({
    ownerId: v.id("users"),
    email: v.string(),
    scopes: v.array(v.string()),
    tokenCiphertext: v.string(),
    tokenIv: v.string(),
    tokenTag: v.string(),
    /** Appended to every email body. */
    signature: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    lastError: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    connectedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  gmailOauthStates: defineTable({
    ownerId: v.id("users"),
    state: v.string(),
    expiresAt: v.number(),
  }).index("by_state", ["state"]),
});
