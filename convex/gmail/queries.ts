import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireOwner } from "../lib/authz";
import { GMAIL_SCOPES } from "./mutations";

/** Gmail connection health. Never returns token material. */
export const connection = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    account: v.union(
      v.null(),
      v.object({
        email: v.string(),
        signature: v.string(),
        status: v.union(v.literal("active"), v.literal("revoked")),
        canDraft: v.boolean(),
        lastError: v.optional(v.string()),
        lastSyncAt: v.optional(v.number()),
        connectedAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const configured =
      (process.env.GOOGLE_CLIENT_ID ?? "") !== "" && (process.env.GOOGLE_CLIENT_SECRET ?? "") !== "";
    const row = await ctx.db
      .query("gmailConnections")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .unique();
    return {
      configured,
      account:
        row === null
          ? null
          : {
              email: row.email,
              signature: row.signature,
              status: row.status,
              canDraft: GMAIL_SCOPES.every((scope) => row.scopes.includes(scope)),
              lastError: row.lastError,
              lastSyncAt: row.lastSyncAt,
              connectedAt: row.connectedAt,
            },
    };
  },
});
