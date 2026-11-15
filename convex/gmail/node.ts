"use node";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireOwnerAction } from "../lib/authz";
import { buildMime, toBase64Url } from "../../src/lib/gmail/mime";
import { readThread, SYNC_HEADERS } from "../../src/lib/gmail/thread";
import { followUpBody, followUpSubject } from "../../src/lib/gmail/followUp";

/**
 * The only module that talks to Google, and the only place the Gmail refresh
 * token exists in plaintext.
 *
 * Hosts reached from here: oauth2.googleapis.com (token exchange/refresh) and
 * gmail.googleapis.com (create drafts, read thread metadata). Nothing else.
 * It never sends: the owner schedules every draft in Gmail. The unit
 * test tests/unit/no-transport.test.ts pins that.
 *
 * The token is sealed with AES-256-GCM using a key derived from the deployment
 * secret `LLM_KEY_SECRET` under a Gmail-specific label, so it is unreadable in
 * a snapshot or export and cannot be swapped with the LLM key ciphertext.
 */

const ALGORITHM = "aes-256-gcm";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function sealingKey(): Buffer {
  const secret = process.env.LLM_KEY_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error("LLM_KEY_SECRET is not configured on this deployment");
  }
  return createHash("sha256").update(`gmail-refresh-token:${secret}`).digest();
}

function seal(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, sealingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function unseal(input: { ciphertext: string; iv: string; tag: string }): string {
  const decipher = createDecipheriv(ALGORITHM, sealingKey(), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Strip anything token-shaped before an error is stored or shown. */
function scrub(message: string): string {
  return message
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/1\/\/[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .slice(0, 400);
}

class GoogleError extends Error {
  constructor(
    message: string,
    readonly revoked: boolean,
  ) {
    super(message);
  }
}

async function googleJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through with an empty body
  }
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "";
    const detail =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof (body.error as { message?: unknown } | undefined)?.message === "string"
          ? (body.error as { message: string }).message
          : text.slice(0, 200);
    throw new GoogleError(
      scrub(`${what} failed (${response.status}${code === "" ? "" : ` ${code}`}): ${detail}`),
      code === "invalid_grant",
    );
  }
  return body;
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (clientId === "" || clientSecret === "") {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on this deployment");
  }
  return { clientId, clientSecret };
}

interface Connection {
  email: string;
  signature: string;
  accessToken: string;
}

async function openConnection(ctx: ActionCtx): Promise<Connection> {
  const sealed = await ctx.runQuery(internal.gmail.mutations.connectionForAction, {});
  if (sealed === null) throw new GoogleError("Gmail is not connected", false);

  let refreshToken: string;
  try {
    refreshToken = unseal({
      ciphertext: sealed.tokenCiphertext,
      iv: sealed.tokenIv,
      tag: sealed.tokenTag,
    });
  } catch {
    throw new GoogleError("Stored Gmail token could not be decrypted. Reconnect Gmail in Settings", true);
  }

  const { clientId, clientSecret } = clientCredentials();
  const body = await googleJson(
    await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    }),
    "Token refresh",
  );
  if (typeof body.access_token !== "string") throw new GoogleError("Token refresh returned no access token", false);
  return { email: sealed.email, signature: sealed.signature, accessToken: body.access_token };
}

async function noteConnectionError(ctx: ActionCtx, error: unknown): Promise<string> {
  const message = scrub(error instanceof Error ? error.message : String(error));
  await ctx.runMutation(internal.gmail.mutations.recordConnectionError, {
    error: message,
    revoked: error instanceof GoogleError && error.revoked,
    now: Date.now(),
  });
  return message;
}

// ── OAuth ──────────────────────────────────────────────────────────────────

/** Called by the HTTP callback after the `state` has been verified and consumed. */
export const completeOAuth = internalAction({
  args: { ownerId: v.id("users"), code: v.string(), redirectUri: v.string() },
  returns: v.object({ ok: v.boolean(), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    try {
      const { clientId, clientSecret } = clientCredentials();
      const tokens = await googleJson(
        await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: args.code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: args.redirectUri,
            grant_type: "authorization_code",
          }),
        }),
        "Code exchange",
      );

      const refreshToken = tokens.refresh_token;
      const accessToken = tokens.access_token;
      if (typeof refreshToken !== "string" || typeof accessToken !== "string") {
        return {
          ok: false,
          error:
            "Google returned no refresh token. Remove Job Hunter at myaccount.google.com/permissions, then connect again",
        };
      }
      const granted = typeof tokens.scope === "string" ? tokens.scope.split(" ") : [];
      const needed = ["gmail.compose", "gmail.readonly"];
      const missing = needed.filter((scope) => !granted.some((g) => g.endsWith(scope)));
      if (missing.length > 0) {
        return { ok: false, error: `Permission not granted: ${missing.join(", ")}. Tick every box on the Google screen` };
      }

      const profile = await googleJson(
        await fetch(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${accessToken}` } }),
        "Profile lookup",
      );
      if (typeof profile.emailAddress !== "string") {
        return { ok: false, error: "Could not read the Gmail address" };
      }

      const sealed = seal(refreshToken);
      await ctx.runMutation(internal.gmail.mutations.storeConnection, {
        ownerId: args.ownerId,
        email: profile.emailAddress,
        scopes: granted,
        tokenCiphertext: sealed.ciphertext,
        tokenIv: sealed.iv,
        tokenTag: sealed.tag,
        now: Date.now(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) };
    }
  },
});

// ── Drafts ─────────────────────────────────────────────────────────────────

function withSignature(body: string, signature: string): string {
  const trimmed = signature.trim();
  return trimmed === "" ? body : `${body.trimEnd()}\n${trimmed}\n`;
}

async function postDraft(
  connection: Connection,
  raw: string,
  threadId?: string,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const body = await googleJson(
    await fetch(`${GMAIL}/drafts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { raw: toBase64Url(raw), ...(threadId !== undefined ? { threadId } : {}) },
      }),
    }),
    "Create draft",
  );
  const message = body.message as { id?: unknown; threadId?: unknown } | undefined;
  if (typeof body.id !== "string" || typeof message?.id !== "string" || typeof message.threadId !== "string") {
    throw new Error("Gmail created the draft but returned no id");
  }
  return { draftId: body.id, messageId: message.id, threadId: message.threadId };
}

/** Create the application email as a draft in the owner's Gmail, with the resume attached. */
export const createDraft = internalAction({
  args: { roleId: v.id("roles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.gmail.mutations.draftJob, { roleId: args.roleId });
    if (job === null) return null;
    try {
      const connection = await openConnection(ctx);
      let attachment: { filename: string; mimeType: string; data: Uint8Array } | undefined;
      if (job.storageId !== undefined) {
        const blob = await ctx.storage.get(job.storageId);
        if (blob === null) throw new Error("The resume PDF is missing from storage");
        attachment = {
          filename: job.filename ?? "YourName-Resume.pdf",
          mimeType: "application/pdf",
          data: new Uint8Array(await blob.arrayBuffer()),
        };
      }
      const raw = buildMime({
        from: connection.email,
        to: job.to,
        subject: job.subject,
        body: withSignature(job.body, connection.signature),
        attachment,
      });
      const draft = await postDraft(connection, raw);
      await ctx.runMutation(internal.gmail.mutations.recordDraft, {
        roleId: args.roleId,
        draftId: draft.draftId,
        messageId: draft.messageId,
        threadId: draft.threadId,
        now: Date.now(),
      });
    } catch (error) {
      const message =
        error instanceof GoogleError
          ? await noteConnectionError(ctx, error)
          : scrub(error instanceof Error ? error.message : String(error));
      await ctx.runMutation(internal.gmail.mutations.recordDraftError, {
        roleId: args.roleId,
        error: `Gmail draft not created: ${message}`,
      });
    }
    return null;
  },
});

// ── Sync ───────────────────────────────────────────────────────────────────

async function syncAll(ctx: ActionCtx): Promise<{ checked: number; followUps: number; error?: string }> {
  const now = Date.now();
  let connection: Connection;
  try {
    connection = await openConnection(ctx);
  } catch (error) {
    if (error instanceof GoogleError && error.message === "Gmail is not connected") {
      return { checked: 0, followUps: 0, error: error.message };
    }
    return { checked: 0, followUps: 0, error: await noteConnectionError(ctx, error) };
  }

  const threads = await ctx.runQuery(internal.gmail.mutations.threadsToSync, {});
  const me = connection.email.toLowerCase();
  const query = SYNC_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");

  for (const thread of threads) {
    try {
      const response = await fetch(`${GMAIL}/threads/${thread.threadId}?format=metadata&${query}`, {
        headers: { authorization: `Bearer ${connection.accessToken}` },
      });
      if (response.status === 404) {
        await ctx.runMutation(internal.gmail.mutations.recordThread, {
          roleId: thread.roleId,
          missing: true,
          scheduled: false,
          replies: [],
          now,
        });
        continue;
      }
      const body = await googleJson(response, "Thread read");
      const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
      const reading = readThread(messages, me);
      await ctx.runMutation(internal.gmail.mutations.recordThread, {
        roleId: thread.roleId,
        missing: false,
        ...reading,
        now,
      });
    } catch (error) {
      if (error instanceof GoogleError && error.revoked) {
        return { checked: 0, followUps: 0, error: await noteConnectionError(ctx, error) };
      }
      // One unreadable thread must not stop the rest.
    }
  }

  // Follow-ups: one draft per silent thread, a week after the email left.
  let followUps = 0;
  const due = await ctx.runQuery(internal.gmail.mutations.followUpsDue, { now });
  for (const item of due) {
    try {
      const raw = buildMime({
        from: connection.email,
        to: item.to,
        subject: followUpSubject(item.subject),
        body: withSignature(followUpBody({ role: item.title, sentAt: item.sentAt }), connection.signature),
        inReplyTo: item.rfcMessageId,
      });
      const draft = await postDraft(connection, raw, item.threadId);
      await ctx.runMutation(internal.gmail.mutations.recordFollowUpDraft, {
        roleId: item.roleId,
        draftId: draft.draftId,
        now,
      });
      followUps++;
    } catch (error) {
      if (error instanceof GoogleError && error.revoked) {
        return { checked: threads.length, followUps, error: await noteConnectionError(ctx, error) };
      }
    }
  }

  await ctx.runMutation(internal.gmail.mutations.markSynced, { now });
  return { checked: threads.length, followUps };
}

/** Cron entry point. */
export const syncInbox = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await syncAll(ctx);
    return null;
  },
});

/** "Check Gmail now" button. */
export const syncNow = action({
  args: {},
  returns: v.object({ checked: v.number(), followUps: v.number(), error: v.optional(v.string()) }),
  handler: async (ctx) => {
    await requireOwnerAction(ctx, async (userId) => ctx.runQuery(internal.owner.isOwner, { userId }));
    return await syncAll(ctx);
  },
});

/** Diagnostics (CLI only): label and sender of every message on a role's thread. */
export const inspectThread = internalAction({
  args: { threadId: v.string() },
  returns: v.array(v.object({ labels: v.array(v.string()), from: v.string(), at: v.string() })),
  handler: async (ctx, args) => {
    const connection = await openConnection(ctx);
    const body = await googleJson(
      await fetch(`${GMAIL}/threads/${args.threadId}?format=metadata&metadataHeaders=From`, {
        headers: { authorization: `Bearer ${connection.accessToken}` },
      }),
      "Thread read",
    );
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
    return messages.map((message) => {
      const headers = (message.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers ?? [];
      return {
        labels: Array.isArray(message.labelIds) ? (message.labelIds as string[]) : [],
        from: headers.find((h) => (h.name ?? "").toLowerCase() === "from")?.value ?? "",
        at: new Date(Number(message.internalDate)).toISOString(),
      };
    });
  },
});
