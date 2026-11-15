import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireOwner } from "./lib/authz";

/**
 * Single-owner bootstrap.
 *
 * Spec 4.4: the first authenticated user submits a one-time secret; if no owner
 * exists and the secret matches, they become the owner. Every later claim fails
 * even while the secret remains configured. Bootstrap is per-deployment, so
 * local, preview, and production each claim independently.
 *
 * Lives here rather than in convex/auth.ts because @convex-dev/auth owns that
 * module name for its own exports.
 */

/**
 * Constant-time string comparison.
 *
 * A plain `===` leaks length and prefix information through timing.
 * Hand-written because `node:crypto.timingSafeEqual` is unavailable in the
 * Convex default runtime, which is where mutations execute.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Whether this deployment has an owner, and whether the caller is it.
 *
 * Deliberately callable while unauthenticated — the sign-in page needs it to
 * choose between "claim this deployment" and "sign in". Leaks only booleans.
 */
export const bootstrapStatus = query({
  args: {},
  returns: v.object({
    ownerClaimed: v.boolean(),
    isAuthenticated: v.boolean(),
    isOwner: v.boolean(),
  }),
  handler: async (ctx) => {
    const bootstrap = await ctx.db
      .query("ownerBootstrap")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique();

    const userId = await getAuthUserId(ctx);

    return {
      ownerClaimed: bootstrap !== null,
      isAuthenticated: userId !== null,
      isOwner: bootstrap !== null && userId !== null && bootstrap.claimedByUserId === userId,
    };
  },
});

/**
 * Claim ownership of this deployment. One time only.
 *
 * Atomicity is free: Convex mutations are serializable transactions, so two
 * concurrent claims cannot both observe an empty `ownerBootstrap` and both
 * insert — the second is retried and then rejected by the existence check.
 */
export const claimOwnership = mutation({
  args: { bootstrapSecret: v.string() },
  returns: v.object({ userId: v.id("users") }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("ownerBootstrap")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique();

    // Already claimed. Fail identically whether or not the secret was correct,
    // so this cannot be used as an oracle to test candidate secrets.
    if (existing !== null) {
      throw new Error("Ownership has already been claimed on this deployment");
    }

    const expected = process.env.OWNER_BOOTSTRAP_SECRET;
    if (expected === undefined || expected.length === 0) {
      throw new Error("OWNER_BOOTSTRAP_SECRET is not configured on this deployment");
    }
    if (!secretsMatch(args.bootstrapSecret, expected)) {
      throw new Error("Invalid bootstrap secret");
    }

    const now = Date.now();

    await ctx.db.patch(userId, {
      role: "owner" as const,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("ownerBootstrap", {
      key: "owner" as const,
      claimedByUserId: userId,
      claimedAt: now,
    });

    return { userId };
  },
});

/** The authenticated owner's own record. Throws for anyone else. */
export const currentOwner = query({
  args: {},
  returns: v.object({
    _id: v.id("users"),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const user = await requireOwner(ctx);
    return { _id: user._id, email: user.email, name: user.name };
  },
});

/**
 * Change the owner's sign-in email.
 *
 * Two rows carry it: `users.email`, and `authAccounts.providerAccountId`, which
 * is the identifier the Password provider looks up at sign-in. Changing one and
 * not the other leaves an account that cannot be signed into — the user row
 * would say one address while authentication still expects the other.
 *
 * The password is unaffected. `Password` hashes the secret alone
 * (`new Scrypt().hash(password)`), with no email mixed in, so the stored hash
 * stays valid across a rename.
 *
 * Internal: an email change is an ops action run from the CLI against a named
 * deployment, not something the app offers a browser. `from` is required and
 * checked, so this cannot be pointed at the wrong account by a typo.
 */
export const changeOwnerEmail = internalMutation({
  args: { from: v.string(), to: v.string(), now: v.number() },
  returns: v.object({
    changed: v.boolean(),
    reason: v.optional(v.string()),
    userId: v.optional(v.id("users")),
  }),
  handler: async (ctx, args) => {
    const to = args.to.trim().toLowerCase();
    const from = args.from.trim().toLowerCase();

    if (to === "" || !to.includes("@")) {
      return { changed: false, reason: "The new address is not an email" };
    }

    const claim = await ctx.db
      .query("ownerBootstrap")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique();
    if (claim === null) {
      return { changed: false, reason: "This deployment has no owner yet" };
    }

    const user = await ctx.db.get(claim.claimedByUserId);
    if (user === null) {
      return { changed: false, reason: "The owner row is missing" };
    }

    // Guard against renaming an account the caller did not mean.
    if ((user.email ?? "").toLowerCase() !== from) {
      return {
        changed: false,
        reason: `The owner's email is not "${args.from}"`,
      };
    }

    if (from === to) return { changed: false, reason: "Already that address" };

    const accounts = await ctx.db.query("authAccounts").take(50);
    const clash = accounts.find(
      (account) =>
        account.providerAccountId.toLowerCase() === to &&
        account.userId !== user._id,
    );
    if (clash !== undefined) {
      return { changed: false, reason: "Another account already uses that address" };
    }

    await ctx.db.patch(user._id, { email: to, updatedAt: args.now });

    for (const account of accounts) {
      if (account.userId !== user._id) continue;
      if (account.provider !== "password") continue;
      await ctx.db.patch(account._id, { providerAccountId: to });
    }

    return { changed: true, userId: user._id };
  },
});

/** Action-side owner check, for `requireOwnerAction`. */
export const isOwner = internalQuery({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const claim = await ctx.db
      .query("ownerBootstrap")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique();
    if (claim === null || claim.claimedByUserId !== args.userId) return false;
    const user = await ctx.db.get(args.userId);
    return user !== null && user.role === "owner" && user.status === "active";
  },
});
