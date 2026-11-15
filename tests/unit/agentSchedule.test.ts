import { describe, expect, it } from "vitest";
import { buildSchedule, clockText, dayStart, untilText, type ScheduleSettings } from "@/lib/agentSchedule";

const H = 3_600_000;
const M = 60_000;
// 2026-11-14 00:00 in Tehran (UTC+03:30) is 2026-11-13 20:30 UTC.
const DAY0 = Date.UTC(2026, 10, 13, 20, 30);
const at = (hour: number, minute = 0) => DAY0 + hour * H + minute * M;

const settings: ScheduleSettings = { paused: false, quietFrom: 0, quietTo: 8, exploreHours: [9, 21], scoreEveryHours: 3 };

describe("agent schedule", () => {
  it("uses the agent laptop's clock", () => {
    expect(dayStart(at(13, 7))).toBe(DAY0);
    expect(clockText(at(20, 50))).toBe("20:50");
  });

  it("lists today's slots and marks the next real run", () => {
    const slots = buildSchedule({ now: at(19, 40), settings, runs: [], fromDay: DAY0, days: 1 });
    const next = slots.find((slot) => slot.status === "next");
    expect(next?.kind).toBe("collect");
    expect(next?.time).toBe("20:50");
    expect(slots.filter((slot) => slot.status === "next")).toHaveLength(1);
    // Score at 21:00 and web search at 21:15 are scheduled after it.
    expect(slots.find((slot) => slot.kind === "score" && slot.time === "21:00")?.status).toBe("upcoming");
    expect(slots.find((slot) => slot.kind === "explore" && slot.time === "21:15")?.status).toBe("upcoming");
  });

  it("quiet hours stop Claude work but not the collector", () => {
    const slots = buildSchedule({ now: at(0, 1), settings, runs: [], fromDay: DAY0, days: 1 });
    expect(slots.find((slot) => slot.kind === "score" && slot.time === "03:00")?.status).toBe("quiet");
    expect(slots.find((slot) => slot.kind === "collect" && slot.time === "02:50")?.status).toBe("next");
  });

  it("past slots come from recorded runs", () => {
    const runs = [
      { agent: "frontend", startedAt: at(15, 0) + 5000, finishedAt: at(15, 1), ok: true },
      { agent: "fullstack", startedAt: at(15, 0) + 6000, finishedAt: at(15, 2), ok: true },
      { agent: "prep", startedAt: at(15, 30) + 3000, finishedAt: at(15, 31), ok: false },
    ];
    const slots = buildSchedule({ now: at(16), settings, runs, fromDay: DAY0, days: 1 });
    expect(slots.find((slot) => slot.kind === "score" && slot.time === "15:00")?.status).toBe("done");
    expect(slots.find((slot) => slot.kind === "prep" && slot.time === "15:30")?.status).toBe("failed");
    expect(slots.find((slot) => slot.kind === "collect" && slot.time === "14:50")?.status).toBe("missed");
  });

  it("the startup finder skips the day after it ran", () => {
    const runs = [{ agent: "startups", startedAt: at(11) + 2000, finishedAt: at(11, 20), ok: true }];
    const slots = buildSchedule({ now: at(12), settings, runs, fromDay: DAY0, days: 3 });
    const startups = slots.filter((slot) => slot.kind === "startups").map((slot) => slot.status);
    expect(startups).toEqual(["done", "skip", "upcoming"]);
  });

  it("a paused app schedules nothing", () => {
    const slots = buildSchedule({ now: at(12), settings: { ...settings, paused: true }, runs: [], fromDay: DAY0, days: 1 });
    expect(slots.some((slot) => slot.status === "next" || slot.status === "upcoming")).toBe(false);
  });

  it("formats the countdown", () => {
    expect(untilText(23 * M)).toBe("in 23 min");
    expect(untilText(2 * H + 5 * M)).toBe("in 2 h 5 min");
    expect(untilText(10_000)).toBe("now");
  });
});
