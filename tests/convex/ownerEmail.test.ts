import { describe, expect, it } from "vitest";
import { internal } from "../../convex/_generated/api";
import { bootstrappedOwner } from "./helpers";

/**
 * Changing the owner's sign-in email.
 *
 * The failure that matters is a half-rename: `users.email` updated while
 * `authAccounts.providerAccountId` still holds the old address leaves an
 * account nobody can sign into, and the app looks fine until the next sign-in.
 */

async function emails(t: Awaited<ReturnType<typeof bootstrappedOwner>>["t"]) {
  return await t.run(async (ctx) => {
    const users = await ctx.db.query("users").take(5);
    const accounts = await ctx.db.query("authAccounts").take(5);
    return {
      user: users[0]?.email,
      account: accounts[0]?.providerAccountId,
      secret: accounts[0]?.secret,
    };
  });
}

async function withPasswordAccount(email: string) {
  const context = await bootstrappedOwner();
  await context.t.run(async (ctx) => {
    await ctx.db.patch(context.owner.userId, { email });
    await ctx.db.insert("authAccounts", {
      userId: context.owner.userId,
      provider: "password",
      providerAccountId: email,
      secret: "scrypt-hash-of-the-password",
    });
  });
  return context;
}

describe("changeOwnerEmail", () => {
  it("renames both rows, and leaves the password hash alone", async () => {
    const { t } = await withPasswordAccount("old@example.test");

    const result = await t.mutation(internal.owner.changeOwnerEmail, {
      from: "old@example.test",
      to: "new@example.test",
      now: 1_000,
    });

    expect(result.changed).toBe(true);
    const after = await emails(t);
    expect(after.user).toBe("new@example.test");
    expect(after.account).toBe("new@example.test");
    // The hash is over the password only, so it must survive untouched.
    expect(after.secret).toBe("scrypt-hash-of-the-password");
  });

  it("refuses when `from` does not match, so a typo cannot rename the wrong account", async () => {
    const { t } = await withPasswordAccount("old@example.test");

    const result = await t.mutation(internal.owner.changeOwnerEmail, {
      from: "someone.else@example.test",
      to: "new@example.test",
      now: 1_000,
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toContain("not");
    expect((await emails(t)).user).toBe("old@example.test");
  });

  it("refuses an address another account already uses", async () => {
    const context = await withPasswordAccount("old@example.test");
    await context.t.run(async (ctx) => {
      const otherUserId = await ctx.db.insert("users", {
        email: "taken@example.test",
        role: "owner" as const,
        status: "active" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("authAccounts", {
        userId: otherUserId,
        provider: "password",
        providerAccountId: "taken@example.test",
        secret: "other",
      });
    });

    const result = await context.t.mutation(internal.owner.changeOwnerEmail, {
      from: "old@example.test",
      to: "taken@example.test",
      now: 1_000,
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toContain("already uses");
  });

  it("refuses something that is not an email", async () => {
    const { t } = await withPasswordAccount("old@example.test");

    const result = await t.mutation(internal.owner.changeOwnerEmail, {
      from: "old@example.test",
      to: "not-an-email",
      now: 1_000,
    });

    expect(result.changed).toBe(false);
  });

  it("is a no-op when the address is already set", async () => {
    const { t } = await withPasswordAccount("same@example.test");

    const result = await t.mutation(internal.owner.changeOwnerEmail, {
      from: "same@example.test",
      to: "same@example.test",
      now: 1_000,
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toContain("Already");
  });
});
