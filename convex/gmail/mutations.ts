import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireOwner } from "../lib/authz";
import { DAY_MS } from "../../src/lib/time";
import { FOLLOW_UP_AFTER_DAYS } from "../../src/lib/gmail/followUp";

/**
 * Gmail state.
 *
 * Nothing here sends mail. The app only creates DRAFTS in the owner's Gmail;
 * the owner schedules them in Gmail. Sync then reads the thread to learn when
 * the email really left, whether anyone answered, and when a follow-up is due.
 */

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
];

export const DEFAULT_SIGNATURE = [
  "Your Name",
  "linkedin.com/in/your-name",
  "github.com/your-name",
  "your-name.github.io",
].join("\n");

const STATE_TTL_MS = 10 * 60 * 1000;
const FOLLOW_UP_MS = FOLLOW_UP_AFTER_DAYS * DAY_MS;

/**
 * Google only accepts plain-http redirect URIs on `localhost`, so the local
 * backend's 127.0.0.1 address is rewritten. Override with GMAIL_REDIRECT_URI.
 */
export function redirectUri(): string {
  const override = process.env.GMAIL_REDIRECT_URI;
  if (override !== undefined && override !== "") return override;
  const site = process.env.CONVEX_SITE_URL;
  if (site === undefined || site === "") throw new Error("CONVEX_SITE_URL is not available");
  return `${site.replace(/\/$/, "").replace("://127.0.0.1", "://localhost")}/gmail/oauth/callback`;
}

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function activeConnection(ctx: QueryCtx | MutationCtx): Promise<Doc<"gmailConnections"> | null> {
  const rows = await ctx.db.query("gmailConnections").take(5);
  return rows.find((row) => row.status === "active") ?? null;
}

// ── Connection ─────────────────────────────────────────────────────────────

/** Start the Google consent flow. Returns the URL the browser should open. */
export const startConnect = mutation({
  args: { now: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId === undefined || clientId === "") {
      throw new Error("GOOGLE_CLIENT_ID is not set on this deployment");
    }
    const state = randomState();
    await ctx.db.insert("gmailOauthStates", {
      ownerId: owner._id,
      state,
      expiresAt: args.now + STATE_TTL_MS,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: GMAIL_SCOPES.join(" "),
      // offline + consent is what makes Google return a refresh token every time.
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },
});

/** One-time use: returns the owner who started this flow, and deletes the state. */
export const consumeOauthState = internalMutation({
  args: { state: v.string(), now: v.number() },
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("gmailOauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (row === null) return null;
    await ctx.db.delete(row._id);
    return row.expiresAt >= args.now ? row.ownerId : null;
  },
});

export const storeConnection = internalMutation({
  args: {
    ownerId: v.id("users"),
    email: v.string(),
    scopes: v.array(v.string()),
    tokenCiphertext: v.string(),
    tokenIv: v.string(),
    tokenTag: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("gmailConnections")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    const fields = {
      email: args.email,
      scopes: args.scopes,
      tokenCiphertext: args.tokenCiphertext,
      tokenIv: args.tokenIv,
      tokenTag: args.tokenTag,
      status: "active" as const,
      lastError: undefined,
      updatedAt: args.now,
    };
    if (existing === null) {
      await ctx.db.insert("gmailConnections", {
        ownerId: args.ownerId,
        ...fields,
        signature: DEFAULT_SIGNATURE,
        connectedAt: args.now,
      });
    } else {
      await ctx.db.patch(existing._id, { ...fields, connectedAt: args.now });
    }
    return null;
  },
});

export const disconnect = mutation({
  args: { now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const row = await ctx.db
      .query("gmailConnections")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .unique();
    if (row === null) return null;
    await ctx.db.patch(row._id, {
      status: "revoked" as const,
      tokenCiphertext: "",
      tokenIv: "",
      tokenTag: "",
      updatedAt: args.now,
    });
    return null;
  },
});

export const updateSignature = mutation({
  args: { signature: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const row = await activeConnection(ctx);
    if (row === null) throw new Error("Gmail is not connected");
    if (args.signature.length > 600) throw new Error("Signature is too long");
    await ctx.db.patch(row._id, { signature: args.signature.trim(), updatedAt: args.now });
    return null;
  },
});

export const recordConnectionError = internalMutation({
  args: { error: v.string(), revoked: v.boolean(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await activeConnection(ctx);
    if (row === null) return null;
    await ctx.db.patch(row._id, {
      lastError: args.error,
      ...(args.revoked ? { status: "revoked" as const } : {}),
      updatedAt: args.now,
    });
    return null;
  },
});

export const markSynced = internalMutation({
  args: { now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await activeConnection(ctx);
    if (row !== null) await ctx.db.patch(row._id, { lastSyncAt: args.now, lastError: undefined });
    return null;
  },
});

/** Internal only: the sealed token for the Node action. No public query returns it. */
export const connectionForAction = internalQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      signature: v.string(),
      tokenCiphertext: v.string(),
      tokenIv: v.string(),
      tokenTag: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const row = await activeConnection(ctx);
    if (row === null) return null;
    return {
      email: row.email,
      signature: row.signature,
      tokenCiphertext: row.tokenCiphertext,
      tokenIv: row.tokenIv,
      tokenTag: row.tokenTag,
    };
  },
});

// ── Drafts ─────────────────────────────────────────────────────────────────

/** What createDraft needs for one role, or null when there is nothing to draft. */
export const draftJob = internalQuery({
  args: { roleId: v.id("roles") },
  returns: v.union(
    v.null(),
    v.object({
      to: v.string(),
      subject: v.string(),
      body: v.string(),
      storageId: v.optional(v.id("_storage")),
      filename: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.roleId);
    if (role === null) return null;
    if (role.gmailDraftId !== undefined || role.sentAt !== undefined) return null;
    if (role.applyEmail === undefined || role.emailSubject === undefined || role.emailBody === undefined) {
      return null;
    }
    return {
      to: role.applyEmail,
      subject: role.emailSubject,
      body: role.emailBody,
      storageId: role.resumeStorageId,
      filename: role.resumeFilename,
    };
  },
});

export const recordDraft = internalMutation({
  args: {
    roleId: v.id("roles"),
    draftId: v.string(),
    messageId: v.string(),
    threadId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.roleId, {
      gmailDraftId: args.draftId,
      gmailMessageId: args.messageId,
      gmailThreadId: args.threadId,
      draftedAt: args.now,
      emailError: undefined,
    });
    return null;
  },
});

export const recordDraftError = internalMutation({
  args: { roleId: v.id("roles"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.roleId, { emailError: args.error.slice(0, 600) });
    return null;
  },
});

/** Owner: create the Gmail draft again (after an error, or after deleting it in Gmail). */
export const retryDraft = mutation({
  args: { roleId: v.id("roles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const role = await ctx.db.get(args.roleId);
    if (role === null) throw new Error("Role not found");
    if (role.gmailDraftId !== undefined || role.sentAt !== undefined) return null;
    await ctx.db.patch(role._id, { emailError: undefined });
    await ctx.scheduler.runAfter(0, internal.gmail.node.createDraft, { roleId: role._id });
    return null;
  },
});

// ── Sync ───────────────────────────────────────────────────────────────────

const SYNC_STAGES = ["ready", "applied", "replied", "no_response"] as const;

/** Roles whose Gmail thread is worth reading. */
export const threadsToSync = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      roleId: v.id("roles"),
      threadId: v.string(),
      sentAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const out = [];
    for (const stage of SYNC_STAGES) {
      const rows = await ctx.db
        .query("roles")
        .withIndex("by_stage_and_found_at", (q) => q.eq("stage", stage))
        .order("desc")
        .take(300);
      for (const row of rows) {
        if (row.gmailThreadId === undefined) continue;
        out.push({ roleId: row._id, threadId: row.gmailThreadId, sentAt: row.sentAt });
      }
    }
    return out;
  },
});

const replyInput = v.object({
  from: v.string(),
  snippet: v.string(),
  at: v.number(),
  kind: v.union(v.literal("reply"), v.literal("auto_reply"), v.literal("bounce")),
});

/**
 * What one read of the thread showed.
 *
 *   missing        the thread is gone and nothing was sent: the draft was deleted
 *   scheduled      our message is waiting in Gmail's Scheduled folder
 *   sent           our first message left Gmail at this time
 *   followUpSentAt our second message left Gmail
 *   replies        messages from anyone else, after our send
 */
export const recordThread = internalMutation({
  args: {
    roleId: v.id("roles"),
    missing: v.boolean(),
    scheduled: v.boolean(),
    scheduledFor: v.optional(v.number()),
    sent: v.optional(v.object({ at: v.number(), rfcMessageId: v.optional(v.string()) })),
    followUpSentAt: v.optional(v.number()),
    replies: v.array(replyInput),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.roleId);
    if (role === null) return null;
    const patch: Partial<Doc<"roles">> = {};

    if (args.missing && role.sentAt === undefined) {
      await ctx.db.patch(role._id, {
        gmailDraftId: undefined,
        gmailThreadId: undefined,
        gmailMessageId: undefined,
        scheduledInGmail: undefined,
        emailError: "The draft was deleted in Gmail. Use Create draft again if you still want it",
      });
      return null;
    }

    if (role.sentAt === undefined && ((role.scheduledInGmail ?? false) !== args.scheduled || role.scheduledFor !== args.scheduledFor)) {
      patch.scheduledInGmail = args.scheduled;
      patch.scheduledFor = args.scheduled ? args.scheduledFor : undefined;
    }

    let stage = role.stage;
    if (args.sent !== undefined && role.sentAt === undefined) {
      patch.sentAt = args.sent.at;
      patch.rfcMessageId = args.sent.rfcMessageId;
      patch.gmailDraftId = undefined;
      patch.scheduledInGmail = undefined;
      patch.scheduledFor = undefined;
      if (role.appliedAt === undefined) patch.appliedAt = args.sent.at;
      if (stage === "ready") stage = "applied";
    }
    if (args.followUpSentAt !== undefined && role.followUpSentAt === undefined) {
      patch.followUpSentAt = args.followUpSentAt;
      patch.followUpDraftId = undefined;
    }

    if (args.replies.some((reply) => reply.kind === "bounce") && role.bounced !== true) {
      patch.bounced = true;
      patch.emailError = "Gmail could not deliver this email (bounced)";
    }
    const human = args.replies.filter((reply) => reply.kind === "reply");
    if (human.length > 0) {
      const latest = human.reduce((a, b) => (b.at > a.at ? b : a));
      const first = human.reduce((a, b) => (b.at < a.at ? b : a));
      if (role.repliedAt === undefined) patch.repliedAt = first.at;
      if (role.lastReplySnippet !== latest.snippet.slice(0, 500)) {
        patch.lastReplyFrom = latest.from.slice(0, 200);
        patch.lastReplySnippet = latest.snippet.slice(0, 500);
      }
      if (stage === "applied" || stage === "no_response") stage = "replied";
    }

    // A week after the follow-up left, with no answer: no response.
    const followUpSent = patch.followUpSentAt ?? role.followUpSentAt;
    const replied = (patch.repliedAt ?? role.repliedAt) !== undefined;
    if (stage === "applied" && followUpSent !== undefined && !replied && args.now - followUpSent >= FOLLOW_UP_MS) {
      stage = "no_response";
      patch.closedAt = args.now;
    }

    if (stage !== role.stage) {
      patch.stage = stage;
      patch.stageChangedAt = args.now;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(role._id, patch);
    return null;
  },
});

/** Sent emails with no answer after 7 days and no follow-up yet. */
export const followUpsDue = internalQuery({
  args: { now: v.number() },
  returns: v.array(
    v.object({
      roleId: v.id("roles"),
      threadId: v.string(),
      to: v.string(),
      subject: v.string(),
      rfcMessageId: v.optional(v.string()),
      title: v.string(),
      sentAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("roles")
      .withIndex("by_stage_and_found_at", (q) => q.eq("stage", "applied"))
      .take(500);
    const out = [];
    for (const row of rows) {
      if (row.sentAt === undefined || row.gmailThreadId === undefined) continue;
      if (row.applyEmail === undefined || row.emailSubject === undefined) continue;
      if (row.repliedAt !== undefined || row.bounced === true) continue;
      if (row.followUpDraftId !== undefined || row.followUpDraftedAt !== undefined) continue;
      if (args.now - row.sentAt < FOLLOW_UP_MS) continue;
      out.push({
        roleId: row._id,
        threadId: row.gmailThreadId,
        to: row.applyEmail,
        subject: row.emailSubject,
        rfcMessageId: row.rfcMessageId,
        title: row.title,
        sentAt: row.sentAt,
      });
    }
    return out.slice(0, 30);
  },
});

export const recordFollowUpDraft = internalMutation({
  args: { roleId: v.id("roles"), draftId: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.roleId, { followUpDraftId: args.draftId, followUpDraftedAt: args.now });
    return null;
  },
});
