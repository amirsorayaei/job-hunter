import { describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { bootstrappedOwner, type TestHarness } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
// Tuesday 10 Nov 2026, 12:00 Istanbul.
const NOW = Date.UTC(2026, 10, 10, 9, 0);

function finding(n: number, score: number, extra: Record<string, unknown> = {}) {
  return {
    key: `acme.com/jobs/${n}`,
    company: `Acme ${n}`,
    title: "Senior Frontend Engineer",
    url: `https://acme.com/jobs/${n}`,
    source: "greenhouse",
    score,
    workMode: "remote" as const,
    remoteWording: "Remote (EMEA)",
    whyFit: "React, TypeScript, Next.js",
    gaps: "",
    mustHaves: ["React", "TypeScript"],
    ...extra,
  };
}

async function roleByKey(t: TestHarness, key: string) {
  return await t.run(async (ctx) => await ctx.db.query("roles").withIndex("by_key", (q) => q.eq("key", key)).unique());
}

async function storeFakePdf(t: TestHarness): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob(["%PDF-1.4 fake"], { type: "application/pdf" })));
}

describe("ingesting agent findings", () => {
  it("hides low scores, skips duplicates, and auto-queues the best roles", async () => {
    const { t } = await bootstrappedOwner();
    const result = await t.mutation(internal.roles.ingest, {
      track: "frontend",
      now: NOW,
      findings: [finding(1, 92), finding(2, 85), finding(3, 60), finding(4, 30), finding(1, 92)],
    });
    expect(result).toEqual({ inserted: 3, duplicates: 1, hidden: 1, autoQueued: 2 });

    expect((await roleByKey(t, "acme.com/jobs/1"))?.stage).toBe("preparing");
    expect((await roleByKey(t, "acme.com/jobs/2"))?.prepState).toBe("queued");
    expect((await roleByKey(t, "acme.com/jobs/3"))?.stage).toBe("new");
    expect(await roleByKey(t, "acme.com/jobs/4")).toBeNull();
  });

  it("auto-prepares only email roles when that setting is on", async () => {
    const { t, owner } = await bootstrappedOwner();
    const as = t.withIdentity(owner.identity);
    await as.mutation(api.settings.update, { autoPrepareEmailOnly: true, now: NOW });
    const result = await t.mutation(internal.roles.ingest, {
      track: "frontend",
      now: NOW,
      findings: [finding(1, 90), finding(2, 90, { applyEmail: "jobs@acme.com", applyEmailSource: "https://acme.com/jobs/2" })],
    });
    expect(result.autoQueued).toBe(1);
    const roles = await as.query(api.roles.list, {});
    expect(roles.find((role) => role.company === "Acme 2")?.stage).toBe("preparing");
    expect(roles.find((role) => role.company === "Acme 1")?.stage).toBe("new");
  });

  it("respects the daily auto-prepare cap and the pause switch", async () => {
    const { t, owner } = await bootstrappedOwner();
    await t.withIdentity(owner.identity).mutation(api.settings.update, { dailyPrepCap: 1, now: NOW });
    const first = await t.mutation(internal.roles.ingest, {
      track: "frontend",
      now: NOW,
      findings: [finding(1, 95), finding(2, 90)],
    });
    expect(first.autoQueued).toBe(1);

    // Same Istanbul day: nothing more. Next day: room again.
    const later = await t.mutation(internal.roles.ingest, { track: "frontend", now: NOW + 3_600_000, findings: [] });
    expect(later.autoQueued).toBe(0);
    const tomorrow = await t.mutation(internal.roles.ingest, { track: "frontend", now: NOW + DAY, findings: [] });
    expect(tomorrow.autoQueued).toBe(1);

    await t.withIdentity(owner.identity).mutation(api.settings.update, { paused: true, dailyPrepCap: 10, now: NOW });
    await t.mutation(internal.roles.ingest, { track: "frontend", now: NOW + 2 * DAY, findings: [finding(3, 99)] });
    expect((await roleByKey(t, "acme.com/jobs/3"))?.stage).toBe("new");
    expect(await t.mutation(internal.roles.claimPrep, { now: NOW + 2 * DAY })).toBeNull();
  });

  it("queues already-listed roles once the auto-prepare score is lowered", async () => {
    const { t, owner } = await bootstrappedOwner();
    await t.mutation(internal.roles.ingest, { track: "frontend", now: NOW, findings: [finding(1, 67)] });
    expect((await roleByKey(t, "acme.com/jobs/1"))?.stage).toBe("new");
    await t.withIdentity(owner.identity).mutation(api.settings.update, { autoPrepareMinScore: 65, now: NOW });
    const job = await t.mutation(internal.roles.claimPrep, { now: NOW + 60_000 });
    expect(job?.company).toBe("Acme 1");
  });

  it("keeps models and web-search hours from the Settings page", async () => {
    const { t, owner } = await bootstrappedOwner();
    const saved = await t.withIdentity(owner.identity).mutation(api.settings.update, {
      prepModel: "sonnet",
      exploreHours: [22, 10, 10, 30],
      now: NOW,
    });
    expect(saved.prepModel).toBe("sonnet");
    expect(saved.exploreHours).toEqual([10, 22, 23]);
    expect((await t.query(internal.settings.forAgents, {})).scoreModel).toBe("sonnet");
  });

  it("keeps only a well-formed apply email", async () => {
    const { t } = await bootstrappedOwner();
    await t.mutation(internal.roles.ingest, {
      track: "fullstack",
      now: NOW,
      findings: [finding(1, 60, { applyEmail: "Jobs@Acme.com" }), finding(2, 60, { applyEmail: "not an email" })],
    });
    const good = await roleByKey(t, "acme.com/jobs/1");
    const bad = await roleByKey(t, "acme.com/jobs/2");
    expect(good?.applyKind).toBe("email");
    expect(good?.applyEmail).toBe("jobs@acme.com");
    expect(bad?.applyKind).toBe("form");
    expect(bad?.applyEmail).toBeUndefined();
  });
});

describe("preparation", () => {
  it("claims, retries on failure, and gives up after three attempts", async () => {
    const { t } = await bootstrappedOwner();
    await t.mutation(internal.roles.ingest, { track: "frontend", now: NOW, findings: [finding(1, 90)] });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await t.mutation(internal.roles.claimPrep, { now: NOW + attempt });
      expect(job?.company).toBe("Acme 1");
      await t.mutation(internal.roles.failPrep, { roleId: job!.roleId, error: "boom", final: false, now: NOW });
    }
    const role = await roleByKey(t, "acme.com/jobs/1");
    expect(role?.prepState).toBe("failed");
    expect(role?.stage).toBe("new");
    expect(await t.mutation(internal.roles.claimPrep, { now: NOW + 10 })).toBeNull();
  });

  it("marks a form role ready with its resume and drafts nothing", async () => {
    const { t } = await bootstrappedOwner();
    await t.mutation(internal.roles.ingest, { track: "frontend", now: NOW, findings: [finding(1, 90)] });
    const job = await t.mutation(internal.roles.claimPrep, { now: NOW });
    const result = await t.mutation(internal.roles.completePrep, {
      roleId: job!.roleId,
      storageId: await storeFakePdf(t),
      filename: "YourName-Resume-Acme1.pdf",
      folder: "applications/acme-1",
      summary: "Fit: good",
      now: NOW,
    });
    expect(result.drafted).toBe(false);
    const role = await roleByKey(t, "acme.com/jobs/1");
    expect(role?.stage).toBe("ready");
    expect(role?.applyKind).toBe("form");
    expect(role?.resumeStorageId).toBeDefined();
  });

  it("drafts a clean email but blocks one that claims a skill Candidate lacks", async () => {
    const { t } = await bootstrappedOwner();
    await t.mutation(internal.roles.ingest, {
      track: "frontend",
      now: NOW,
      findings: [finding(1, 90), finding(2, 89)],
    });

    const clean = await t.mutation(internal.roles.claimPrep, { now: NOW });
    const ok = await t.mutation(internal.roles.completePrep, {
      roleId: clean!.roleId,
      storageId: await storeFakePdf(t),
      filename: "YourName-Resume-Acme1.pdf",
      folder: "applications/acme-1",
      summary: "Fit: good",
      email: {
        to: "jobs@acme.com",
        source: "https://acme.com/jobs/1",
        subject: "Senior Frontend Engineer application",
        body: "Hi,\n\nI build React and TypeScript apps. My resume is attached.\n\nThanks,",
      },
      now: NOW,
    });
    expect(ok).toEqual({ drafted: true, emailError: undefined });

    const risky = await t.mutation(internal.roles.claimPrep, { now: NOW });
    const blocked = await t.mutation(internal.roles.completePrep, {
      roleId: risky!.roleId,
      storageId: await storeFakePdf(t),
      filename: "YourName-Resume-Acme2.pdf",
      folder: "applications/acme-2",
      summary: "Fit: good",
      email: {
        to: "jobs@acme.com",
        source: "https://acme.com/jobs/2",
        subject: "Application",
        body: "Hi,\n\nI have years of Kubernetes and Terraform experience.\n\nThanks,",
      },
      now: NOW,
    });
    expect(blocked.drafted).toBe(false);
    expect(blocked.emailError).toMatch(/truthfulness check/);
    expect((await roleByKey(t, "acme.com/jobs/2"))?.applyKind).toBe("email");
  });
});

describe("which validator findings hold an email", () => {
  it("ignores employer product names but blocks invented numbers and claimed gaps", async () => {
    const { emailBlockers } = await import("../../convex/roles");
    const { validateOutreachText } = await import("../../src/lib/tailoring/validate");
    const { buildCatalogue } = await import("../../src/lib/tailoring/catalogue");
    const check = (body: string) =>
      emailBlockers(body, validateOutreachText({ body, factIds: [] }, buildCatalogue(), []).violations).map((v) => v.offending);

    expect(check("The Marker Method looks great. I built Daily/WebRTC consultations and AI report drafts at Levita.")).toEqual([]);
    expect(check("I haven't used AWS in production, but I learn fast.")).toEqual([]);
    expect(check("I run AWS and Kubernetes clusters daily.")).toEqual(["AWS", "Kubernetes"]);
    expect(check("I cut load time by 60%.")).toEqual(["60%"]);
    expect(check("It cut the doctor's work from about 15 minutes to under 5.")).toEqual([]);
  });
});

describe("Gmail thread tracking", () => {
  async function draftedRole() {
    const ctx = await bootstrappedOwner();
    await ctx.t.mutation(internal.roles.ingest, {
      track: "frontend",
      now: NOW,
      findings: [finding(1, 90, { applyEmail: "jobs@acme.com" })],
    });
    const job = await ctx.t.mutation(internal.roles.claimPrep, { now: NOW });
    const roleId = job!.roleId;
    await ctx.t.run(async (db) =>
      db.db.patch(roleId, {
        stage: "ready",
        prepState: "done",
        emailSubject: "Senior Frontend Engineer application",
        emailBody: "Hi,",
        gmailDraftId: "d1",
        gmailThreadId: "t1",
      }),
    );
    return { ...ctx, roleId };
  }

  it("moves to applied when Gmail shows the email left, then replied", async () => {
    const { t, roleId } = await draftedRole();
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: true, replies: [], now: NOW,
    });
    expect((await t.run((ctx) => ctx.db.get(roleId)))?.scheduledInGmail).toBe(true);

    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: false, sent: { at: NOW + 1000, rfcMessageId: "<x@y>" }, replies: [], now: NOW + 2000,
    });
    let role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.stage).toBe("applied");
    expect(role?.appliedAt).toBe(NOW + 1000);
    expect(role?.gmailDraftId).toBeUndefined();

    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId,
      missing: false,
      scheduled: false,
      sent: { at: NOW + 1000 },
      replies: [
        { from: "ooo@acme.com", snippet: "away", at: NOW + 3000, kind: "auto_reply" },
        { from: "Jane <jane@acme.com>", snippet: "Let's talk", at: NOW + 4000, kind: "reply" },
      ],
      now: NOW + 5000,
    });
    role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.stage).toBe("replied");
    expect(role?.repliedAt).toBe(NOW + 4000);
    expect(role?.lastReplySnippet).toBe("Let's talk");
  });

  it("an auto-reply alone is not a reply", async () => {
    const { t, roleId } = await draftedRole();
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: false, sent: { at: NOW },
      replies: [{ from: "ooo@acme.com", snippet: "away", at: NOW + 10, kind: "auto_reply" }],
      now: NOW + 20,
    });
    expect((await t.run((ctx) => ctx.db.get(roleId)))?.stage).toBe("applied");
  });

  it("notices a deleted draft", async () => {
    const { t, roleId } = await draftedRole();
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: true, scheduled: false, replies: [], now: NOW,
    });
    const role = await t.run((ctx) => ctx.db.get(roleId));
    expect(role?.gmailThreadId).toBeUndefined();
    expect(role?.emailError).toMatch(/deleted/);
  });

  it("asks for one follow-up after 7 silent days, then gives up a week after it left", async () => {
    const { t, roleId } = await draftedRole();
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: false, sent: { at: NOW, rfcMessageId: "<x@y>" }, replies: [], now: NOW,
    });

    expect(await t.query(internal.gmail.mutations.followUpsDue, { now: NOW + 6 * DAY })).toEqual([]);
    const due = await t.query(internal.gmail.mutations.followUpsDue, { now: NOW + 7 * DAY });
    expect(due.map((item) => item.rfcMessageId)).toEqual(["<x@y>"]);

    await t.mutation(internal.gmail.mutations.recordFollowUpDraft, { roleId, draftId: "f1", now: NOW + 7 * DAY });
    expect(await t.query(internal.gmail.mutations.followUpsDue, { now: NOW + 8 * DAY })).toEqual([]);

    // Follow-up leaves on day 8; on day 15 still silent → no response.
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: false, sent: { at: NOW }, followUpSentAt: NOW + 8 * DAY, replies: [], now: NOW + 8 * DAY,
    });
    expect((await t.run((ctx) => ctx.db.get(roleId)))?.stage).toBe("applied");
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: false, sent: { at: NOW }, followUpSentAt: NOW + 8 * DAY, replies: [], now: NOW + 15 * DAY,
    });
    expect((await t.run((ctx) => ctx.db.get(roleId)))?.stage).toBe("no_response");
  });

  it("does not ask for a follow-up after a reply or a bounce", async () => {
    const { t, roleId } = await draftedRole();
    await t.mutation(internal.gmail.mutations.recordThread, {
      roleId, missing: false, scheduled: false, sent: { at: NOW },
      replies: [{ from: "mailer-daemon@googlemail.com", snippet: "", at: NOW + 5, kind: "bounce" }],
      now: NOW + 10,
    });
    expect((await t.run((ctx) => ctx.db.get(roleId)))?.bounced).toBe(true);
    expect(await t.query(internal.gmail.mutations.followUpsDue, { now: NOW + 9 * DAY })).toEqual([]);
  });
});

describe("owner actions and dashboard numbers", () => {
  it("dismisses a prepared role with a reason, keeps it, and restore clears the reason", async () => {
    const { t, owner } = await bootstrappedOwner();
    const as = t.withIdentity(owner.identity);
    await t.mutation(internal.roles.ingest, { track: "fullstack", now: NOW, findings: [finding(1, 70)] });
    const [role] = await as.query(api.roles.list, {});
    await as.mutation(api.roles.setStage, { roleId: role._id, stage: "ready", now: NOW });

    await as.mutation(api.roles.dismiss, { roleId: role._id, reason: "Weak company", now: NOW + DAY });
    const [dismissed] = await as.query(api.roles.list, {});
    expect(dismissed.stage).toBe("dismissed");
    expect(dismissed.dismissReason).toBe("Weak company");

    await as.mutation(api.roles.restore, { roleId: role._id, now: NOW + 2 * DAY });
    const [restored] = await as.query(api.roles.list, {});
    expect(restored.stage).not.toBe("dismissed");
    expect(restored.dismissReason).toBeUndefined();
  });

  it("tracks a form application through to an interview", async () => {
    const { t, owner } = await bootstrappedOwner();
    const as = t.withIdentity(owner.identity);
    await t.mutation(internal.roles.ingest, {
      track: "fullstack",
      now: NOW,
      findings: [finding(1, 70), finding(2, 65), finding(3, 55)],
    });
    const roles = await as.query(api.roles.list, {});
    const [a, b, c] = roles.sort((x, y) => x.company.localeCompare(y.company));

    await as.mutation(api.roles.setStage, { roleId: a._id, stage: "applied", now: NOW + DAY });
    await as.mutation(api.roles.setStage, { roleId: b._id, stage: "applied", now: NOW + DAY });
    await as.mutation(api.roles.setStage, { roleId: b._id, stage: "interview", now: NOW + 3 * DAY });
    await as.mutation(api.roles.dismiss, { roleId: c._id, now: NOW });

    const stats = await as.query(api.roles.stats, { now: NOW + 4 * DAY, days: 30 });
    expect(stats.counts.found).toBe(3);
    expect(stats.counts.applied).toBe(2);
    expect(stats.counts.waiting).toBe(1);
    expect(stats.counts.interview).toBe(1);
    expect(stats.counts.replied).toBe(1);
    expect(stats.attention.newRoles).toBe(0);
    expect(stats.byTrack.find((row) => row.track === "fullstack")).toEqual({
      track: "fullstack", applied: 2, replied: 1, interview: 1,
    });
    expect(stats.daily.reduce((sum, day) => sum + day.applied, 0)).toBe(2);
    expect(stats.stages.find((row) => row.stage === "interview")?.count).toBe(1);

    // A period that starts after the applications counts none of them.
    const later = await as.query(api.roles.stats, { now: NOW + 4 * DAY, days: 30, since: NOW + 2 * DAY });
    expect(later.counts.applied).toBe(0);
    expect(later.counts.interview).toBe(1);

    await as.mutation(api.roles.restore, { roleId: c._id, now: NOW });
    expect((await as.query(api.roles.get, { roleId: c._id }))?.role.stage).toBe("new");
  });
});
