import { httpRouter } from "convex/server";
import type { FunctionReference } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { redirectUri } from "./gmail/mutations";

const http = httpRouter();
auth.addHttpRoutes(http);

// ── Gmail consent callback ─────────────────────────────────────────────────

http.route({
  path: "/gmail/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const site = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const back = (result: string) =>
      new Response(null, {
        status: 302,
        headers: { location: `${site}/settings?gmail=${encodeURIComponent(result)}` },
      });

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") !== null) return back("denied");
    if (state === null || code === null) return back("invalid");

    const ownerId = await ctx.runMutation(internal.gmail.mutations.consumeOauthState, {
      state,
      now: Date.now(),
    });
    if (ownerId === null) return back("expired");

    const result = await ctx.runAction(internal.gmail.node.completeOAuth, {
      ownerId,
      code,
      // Must match the URI sent to Google in startConnect, byte for byte.
      redirectUri: redirectUri(),
    });
    return back(result.ok ? "connected" : `error:${result.error ?? "unknown"}`);
  }),
});

// ── Mac agents ─────────────────────────────────────────────────────────────

/** Constant-time compare of the bearer secret. */
function sameSecret(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function agentAuthorized(request: Request): boolean {
  const expected = process.env.AGENT_INGEST_SECRET ?? "";
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return expected.length >= 24 && sameSecret(presented, expected);
}

type Op =
  | { kind: "query"; ref: FunctionReference<"query", "internal"> }
  | { kind: "mutation"; ref: FunctionReference<"mutation", "internal"> };

/**
 * Everything the Mac runners may do, by name. Arguments are validated by each
 * internal function's own validator; a bad call is a 400.
 */
const OPS: Record<string, Op> = {
  "settings.get": { kind: "query", ref: internal.settings.forAgents },
  "companies.active": { kind: "query", ref: internal.companies.active },
  "companies.knownNames": { kind: "query", ref: internal.companies.knownNames },
  "companies.upsert": { kind: "mutation", ref: internal.companies.upsert },
  "companies.recordChecks": { kind: "mutation", ref: internal.companies.recordChecks },
  "postings.unknownKeys": { kind: "query", ref: internal.postings.unknownKeys },
  "postings.add": { kind: "mutation", ref: internal.postings.add },
  "postings.claim": { kind: "mutation", ref: internal.postings.claim },
  "postings.markScored": { kind: "mutation", ref: internal.postings.markScored },
  "postings.pendingCounts": { kind: "query", ref: internal.postings.pendingCounts },
  "postings.pendingSummary": { kind: "query", ref: internal.postings.pendingSummary },
  "roles.ingest": { kind: "mutation", ref: internal.roles.ingest },
  "roles.claimPrep": { kind: "mutation", ref: internal.roles.claimPrep },
  "roles.failPrep": { kind: "mutation", ref: internal.roles.failPrep },
  "runs.start": { kind: "mutation", ref: internal.runs.start },
  "runs.finish": { kind: "mutation", ref: internal.runs.finish },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

http.route({
  path: "/agent/rpc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!agentAuthorized(request)) return new Response("Unauthorized", { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body is not JSON" }, 400);
    }
    if (!isRecord(body) || typeof body.op !== "string" || !isRecord(body.args)) {
      return json({ error: "Expected { op, args }" }, 400);
    }
    const op = OPS[body.op];
    if (op === undefined) return json({ error: `Unknown op ${body.op}` }, 400);
    try {
      const result =
        op.kind === "query"
          ? await ctx.runQuery(op.ref, body.args)
          : await ctx.runMutation(op.ref, body.args);
      return json({ result: result ?? null });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message.slice(0, 500) : "failed" }, 400);
    }
  }),
});

/** Prep finished: the tailored PDF (base64) plus, for email roles, the verified email. */
http.route({
  path: "/agent/prep/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!agentAuthorized(request)) return new Response("Unauthorized", { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body is not JSON" }, 400);
    }
    if (
      !isRecord(body) ||
      typeof body.roleId !== "string" ||
      typeof body.pdfBase64 !== "string" ||
      typeof body.filename !== "string" ||
      typeof body.folder !== "string" ||
      typeof body.summary !== "string"
    ) {
      return json({ error: "Expected roleId, pdfBase64, filename, folder, summary" }, 400);
    }
    let email: { to: string; source: string; subject: string; body: string } | undefined;
    if (body.email !== undefined && body.email !== null) {
      const e = body.email;
      if (
        !isRecord(e) ||
        typeof e.to !== "string" ||
        typeof e.source !== "string" ||
        typeof e.subject !== "string" ||
        typeof e.body !== "string"
      ) {
        return json({ error: "email must have to, source, subject, body" }, 400);
      }
      email = { to: e.to, source: e.source, subject: e.subject, body: e.body };
    }
    if (!/^[A-Za-z0-9._-]{1,120}\.pdf$/.test(body.filename)) {
      return json({ error: "filename must be a plain .pdf name" }, 400);
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const binary = atob(body.pdfBase64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch {
      return json({ error: "pdfBase64 is not base64" }, 400);
    }
    if (bytes.length < 500 || bytes.length > 2_000_000) return json({ error: "PDF size out of range" }, 400);
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return json({ error: "Not a PDF" }, 400);

    const storageId = await ctx.storage.store(new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
    try {
      const result = await ctx.runMutation(internal.roles.completePrep, {
        roleId: body.roleId as Id<"roles">,
        storageId,
        filename: body.filename,
        folder: body.folder,
        summary: body.summary,
        email,
        now: Date.now(),
      });
      return json({ result });
    } catch (error) {
      await ctx.storage.delete(storageId);
      return json({ error: error instanceof Error ? error.message.slice(0, 500) : "failed" }, 400);
    }
  }),
});

export default http;
