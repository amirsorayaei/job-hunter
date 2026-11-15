import { v } from "convex/values";
import { modifyAccountCredentials } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Set the owner's sign-in password from the CLI (`pnpm set-password`).
 * Internal only: no browser can call it. Also clears the failed-attempt
 * counter so a locked-out owner can sign in straight away.
 */

export const ownerEmail = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const claim = await ctx.db
      .query("ownerBootstrap")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique();
    if (claim === null) return null;
    const user = await ctx.db.get(claim.claimedByUserId);
    return user?.email ?? null;
  },
});

export const clearRateLimits = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("authRateLimits").take(50);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

export const set = internalAction({
  args: { password: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (args.password.length < 8) throw new Error("Use at least 8 characters");
    const email: string | null = await ctx.runQuery(internal.ownerPassword.ownerEmail, {});
    if (email === null) throw new Error("This deployment has no owner yet");
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: email, secret: args.password },
    });
    await ctx.runMutation(internal.ownerPassword.clearRateLimits, {});
    return `Password updated for ${email}`;
  },
});
