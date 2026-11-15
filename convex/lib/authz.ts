import { getAuthUserId } from "@convex-dev/auth/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Single-owner authorization.
 *
 * Spec: sections 3.3, 4.4, 5.2. Every public query, mutation, and action must
 * call one of these before reading or writing private data.
 *
 * The rule that matters most: identity is ALWAYS derived server-side, via
 * `getAuthUserId(ctx)`. A `userId` or `ownerId` arriving in function arguments
 * is data, never authority — accepting one is the impersonation defect that
 * `convex-authz` exists to catch.
 */

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

export class NotOwnerError extends Error {
  constructor() {
    super("Not authorized");
    this.name = "NotOwnerError";
  }
}

export class OwnerNotClaimedError extends Error {
  constructor() {
    super("Owner has not been bootstrapped on this deployment");
    this.name = "OwnerNotClaimedError";
  }
}

/** The authenticated user's id, or throw. */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new NotAuthenticatedError();
  return userId;
}

/**
 * Require that the caller is the bootstrapped owner, and return their user doc.
 *
 * Throws rather than returning null so a caller cannot accidentally continue
 * down an unauthenticated code path.
 */
export async function requireOwner(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const userId = await requireUserId(ctx);

  const user = await ctx.db.get(userId);
  if (user === null) throw new NotOwnerError();
  if (user.role !== "owner") throw new NotOwnerError();
  if (user.status !== "active") throw new NotOwnerError();

  // Defence in depth: a users row alone is not authority. The bootstrap record
  // is the single source of truth for who owns this deployment, so a stray row
  // from a bad import or a restored backup cannot by itself grant access.
  const bootstrap = await ctx.db
    .query("ownerBootstrap")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .unique();

  if (bootstrap === null) throw new OwnerNotClaimedError();
  if (bootstrap.claimedByUserId !== user._id) throw new NotOwnerError();

  return user;
}

/**
 * Action-side owner check. Actions have no `ctx.db`, so this resolves the
 * identity here and delegates the database half to an internal query supplied
 * by the caller — keeping one definition of "owner".
 */
export async function requireOwnerAction(
  ctx: ActionCtx,
  resolveOwner: (userId: Id<"users">) => Promise<boolean>,
): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  const isOwner = await resolveOwner(userId);
  if (!isOwner) throw new NotOwnerError();
  return userId;
}

/**
 * Assert a document belongs to the owner.
 *
 * Every read of a document fetched by a client-supplied id must pass through
 * here. Without it, a valid authenticated user can read another tenant's
 * document simply by holding its id — the most common Convex authz defect.
 */
export function assertOwns<T extends { ownerId: Id<"users"> }>(
  doc: T | null,
  owner: Doc<"users">,
): T {
  if (doc === null) throw new NotOwnerError();
  if (doc.ownerId !== owner._id) throw new NotOwnerError();
  return doc;
}
