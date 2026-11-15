import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Shared convex-test fixtures.
 *
 * `@convex-dev/auth` derives the user id from the JWT subject claim, formatted
 * as `<userId>|<sessionId>` (see getAuthUserId in the library). convex-test's
 * `withIdentity` does not create a users row, so tests must insert one and then
 * present a subject in that exact shape — otherwise `getAuthUserId` returns a
 * string that is not a real document id and every ownership check fails for the
 * wrong reason.
 */

export type TestHarness = ReturnType<typeof setup>;

export const SECRET = "test-bootstrap-secret";
const SUBJECT_DIVIDER = "|";


export interface TestIdentity {
  subject: string;
  issuer: string;
  tokenIdentifier: string;
  // convex-test types identities as Partial<UserIdentity>, which carries an
  // index signature for provider-specific claims. Mirror it so these objects
  // are assignable.
  [claim: string]: string;
}

export function setup() {
  process.env.OWNER_BOOTSTRAP_SECRET = SECRET;
  return convexTest(schema, import.meta.glob("../../convex/**/*.ts"));
}

/**
 * Insert a bare authenticated user and return an identity that resolves to it.
 * The user has no `role`/`status` yet — exactly the state Convex Auth leaves a
 * freshly signed-up user in, before ownership is claimed.
 */
export async function createIdentity(
  t: TestHarness,
  label: string,
): Promise<{ userId: Id<"users">; identity: TestIdentity }> {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: `${label}@example.test` }),
  );

  return {
    userId,
    identity: {
      subject: `${userId}${SUBJECT_DIVIDER}session_${label}`,
      issuer: "https://test.convex.site",
      tokenIdentifier: `https://test.convex.site|${userId}`,
    },
  };
}

/** A harness whose owner has claimed the deployment, plus a second identity. */
export async function bootstrappedOwner() {
  const t = setup();
  const owner = await createIdentity(t, "owner");
  const intruder = await createIdentity(t, "intruder");

  await t
    .withIdentity(owner.identity)
    .mutation(api.owner.claimOwnership, { bootstrapSecret: SECRET });

  return { t, owner, intruder };
}
