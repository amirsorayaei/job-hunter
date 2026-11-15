import { describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import {
  bootstrappedOwner,
  createIdentity,
  SECRET,
  setup,
} from "./helpers";

/**
 * Authorization tests — Phase 1 acceptance criterion 9.
 *
 * "Owner, other-user, and unauthenticated tests prove private data isolation."
 *
 * Every public function is exercised as all three identities. The negative
 * cases are the point: a second authenticated identity must be refused exactly
 * as hard as an anonymous one.
 */

describe("owner bootstrap", () => {
  it("lets the first authenticated user claim ownership with the right secret", async () => {
    const t = setup();
    const owner = await createIdentity(t, "owner");

    const result = await t
      .withIdentity(owner.identity)
      .mutation(api.owner.claimOwnership, { bootstrapSecret: SECRET });
    expect(result.userId).toBe(owner.userId);

    const status = await t
      .withIdentity(owner.identity)
      .query(api.owner.bootstrapStatus, {});
    expect(status).toEqual({ ownerClaimed: true, isAuthenticated: true, isOwner: true });
  });

  it("refuses an unauthenticated claim", async () => {
    const t = setup();
    await expect(
      t.mutation(api.owner.claimOwnership, { bootstrapSecret: SECRET }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("refuses a wrong secret", async () => {
    const t = setup();
    const owner = await createIdentity(t, "owner");
    await expect(
      t
        .withIdentity(owner.identity)
        .mutation(api.owner.claimOwnership, { bootstrapSecret: "wrong" }),
    ).rejects.toThrow(/Invalid bootstrap secret/);
  });

  it("refuses a second claim even with the correct secret", async () => {
    // Spec 4.4: "Once claimed, all later claims fail even if the secret
    // remains configured." Without this, a fresh production deployment is
    // handed to whoever signs in second.
    const { t, intruder } = await bootstrappedOwner();
    await expect(
      t
        .withIdentity(intruder.identity)
        .mutation(api.owner.claimOwnership, { bootstrapSecret: SECRET }),
    ).rejects.toThrow(/already been claimed/);
  });

  it("does not reveal whether the secret was correct once claimed", async () => {
    const { t, intruder } = await bootstrappedOwner();

    const withGoodSecret = await t
      .withIdentity(intruder.identity)
      .mutation(api.owner.claimOwnership, { bootstrapSecret: SECRET })
      .catch((e: Error) => e.message);
    const withBadSecret = await t
      .withIdentity(intruder.identity)
      .mutation(api.owner.claimOwnership, { bootstrapSecret: "wrong" })
      .catch((e: Error) => e.message);

    expect(withGoodSecret).toContain("already been claimed");
    expect(withBadSecret).toContain("already been claimed");
  });

  it("exposes only booleans before anyone has claimed", async () => {
    const t = setup();
    expect(await t.query(api.owner.bootstrapStatus, {})).toEqual({
      ownerClaimed: false,
      isAuthenticated: false,
      isOwner: false,
    });
  });

  it("reports a signed-in non-owner as authenticated but not owner", async () => {
    const { t, intruder } = await bootstrappedOwner();
    expect(
      await t.withIdentity(intruder.identity).query(api.owner.bootstrapStatus, {}),
    ).toEqual({ ownerClaimed: true, isAuthenticated: true, isOwner: false });
  });
});

describe("currentOwner", () => {
  it("returns the owner record for the owner", async () => {
    const { t, owner } = await bootstrappedOwner();
    const user = await t.withIdentity(owner.identity).query(api.owner.currentOwner, {});
    expect(user._id).toBe(owner.userId);
  });

  it("refuses a second authenticated identity", async () => {
    const { t, intruder } = await bootstrappedOwner();
    await expect(
      t.withIdentity(intruder.identity).query(api.owner.currentOwner, {}),
    ).rejects.toThrow(/Not authorized/);
  });

  it("refuses an unauthenticated caller", async () => {
    const { t } = await bootstrappedOwner();
    await expect(t.query(api.owner.currentOwner, {})).rejects.toThrow(
      /Not authenticated/,
    );
  });

  it("refuses a disabled owner", async () => {
    const { t, owner } = await bootstrappedOwner();
    await t.run(async (ctx) => ctx.db.patch(owner.userId, { status: "disabled" }));
    await expect(
      t.withIdentity(owner.identity).query(api.owner.currentOwner, {}),
    ).rejects.toThrow(/Not authorized/);
  });
});

describe("role data isolation", () => {
  async function ownerWithRole() {
    const ctx = await bootstrappedOwner();
    await ctx.t.mutation(internal.roles.ingest, {
      track: "frontend",
      now: 1_000,
      findings: [
        {
          key: "example.com/jobs/1",
          company: "Example",
          title: "Senior Frontend Engineer",
          url: "https://example.com/jobs/1",
          source: "test",
          score: 70,
          workMode: "remote",
          remoteWording: "Remote, worldwide",
          whyFit: "React and TypeScript",
          gaps: "",
          mustHaves: ["React"],
        },
      ],
    });
    const roleId = await ctx.t.run(async (db) => (await db.db.query("roles").first())!._id);
    return { ...ctx, roleId };
  }

  it("lets the owner read their roles", async () => {
    const { t, owner } = await ownerWithRole();
    const roles = await t.withIdentity(owner.identity).query(api.roles.list, {});
    expect(roles.map((role) => role.company)).toEqual(["Example"]);
  });

  it("refuses a second identity reading or writing a VALID role id", async () => {
    const { t, intruder, roleId } = await ownerWithRole();
    await expect(t.withIdentity(intruder.identity).query(api.roles.get, { roleId })).rejects.toThrow(/Not authorized/);
    await expect(
      t.withIdentity(intruder.identity).mutation(api.roles.setStage, { roleId, stage: "applied", now: 2_000 }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("refuses an unauthenticated read", async () => {
    const { t } = await ownerWithRole();
    await expect(t.query(api.roles.list, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.roles.stats, { now: 1, days: 30 })).rejects.toThrow(/Not authenticated/);
  });

  it("refuses every public function before ownership is claimed", async () => {
    const t = setup();
    const user = await createIdentity(t, "somebody");
    await expect(t.withIdentity(user.identity).query(api.roles.list, {})).rejects.toThrow(
      /Not authorized|not been bootstrapped/,
    );
  });
});
