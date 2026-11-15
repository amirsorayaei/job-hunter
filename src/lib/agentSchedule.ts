/**
 * The agents' timetable, as the cron on the agent machine runs it, turned into
 * a day-by-day list the Settings page can show ("what runs when, what is next").
 *
 * The cron block itself lives in `scripts/install-agents-linux.sh`. The times
 * below mirror it; change both together. Everything here is pure so it can be
 * unit tested and rendered on any viewer's device: wall-clock times are always
 * the agent machine's clock (Tehran), whatever time zone the browser is in.
 */

export const SCHEDULE_TZ_LABEL = "Tehran time";
/** Asia/Tehran is a fixed UTC+03:30 (no daylight saving since 2022). */
export const SCHEDULE_UTC_OFFSET_MIN = 210;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Hours of the three-hour cycle: score at :00, prep at :30. */
export const CYCLE_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
/** The collector runs ten minutes before each cycle. */
export const COLLECT_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
export const STARTUPS_HOUR = 11;

export type AgentId = "collector" | "frontend" | "fullstack" | "explore" | "startups" | "prep";
export type JobKind = "collect" | "score" | "explore" | "prep" | "startups";

export interface ScheduleSettings {
  paused: boolean;
  quietFrom: number;
  quietTo: number;
  exploreHours: number[];
  scoreEveryHours: number;
}

export interface RunRecord {
  agent: string;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
}

export interface JobDef {
  kind: JobKind;
  label: string;
  /** Shown under the label: which agents and what it costs. */
  detail: string;
  agents: AgentId[];
  minute: number;
  hours: (settings: ScheduleSettings) => number[];
  /** False for agents that keep running in quiet hours (the collector). */
  quiet: boolean;
  /** Minimum time between real runs; slots inside it skip themselves. */
  gapMs?: (settings: ScheduleSettings) => number;
  gapReason?: string;
}

export const JOBS: JobDef[] = [
  {
    kind: "collect",
    label: "Collect postings",
    detail: "Reads every job board · no tokens",
    agents: ["collector"],
    minute: 50,
    hours: () => COLLECT_HOURS,
    quiet: false,
  },
  {
    kind: "score",
    label: "Score postings",
    detail: "Frontend + Full-Stack · Claude",
    agents: ["frontend", "fullstack"],
    minute: 0,
    hours: () => CYCLE_HOURS,
    quiet: true,
    // Same rule as scripts/agent/score.ts (interval from Settings, 10 min slack).
    gapMs: (settings) => settings.scoreEveryHours * HOUR - 10 * MINUTE,
    gapReason: "not due yet",
  },
  {
    kind: "explore",
    label: "Web search",
    detail: "Open web, both tracks · Claude",
    agents: ["explore"],
    minute: 15,
    hours: (settings) => [...settings.exploreHours].sort((a, b) => a - b),
    quiet: true,
    gapMs: () => 3 * HOUR,
    gapReason: "ran recently",
  },
  {
    kind: "prep",
    label: "Prepare resumes",
    detail: "Queued roles only · Claude",
    agents: ["prep"],
    minute: 30,
    hours: () => CYCLE_HOURS,
    quiet: true,
  },
  {
    kind: "startups",
    label: "Startup finder",
    detail: "Every 2 days · Claude, the heaviest",
    agents: ["startups"],
    minute: 0,
    hours: () => [STARTUPS_HOUR],
    quiet: true,
    // Same rule as scripts/agent/startups.ts (2 days minus 2 h slack).
    gapMs: () => 2 * DAY - 2 * HOUR,
    gapReason: "runs every 2 days",
  },
];

export type SlotStatus =
  | "done" // a run was recorded for this slot and it finished fine
  | "failed" // recorded, finished with an error
  | "running" // recorded, still going
  | "missed" // in the past, nothing recorded
  | "next" // the very next slot that will really run
  | "upcoming" // will run
  | "quiet" // inside quiet hours, does nothing
  | "skip" // the agent will skip itself (interval not reached)
  | "paused"; // agents are switched off in Settings

export interface Slot {
  kind: JobKind;
  job: JobDef;
  at: number;
  /** "HH:MM" on the agent machine's clock. */
  time: string;
  status: SlotStatus;
  /** Short explanation for skip/quiet/missed, or how many tracks ran. */
  note?: string;
}

/** Wall-clock hour and minute on the agent machine for an instant. */
export function clockParts(ms: number): { hour: number; minute: number } {
  const local = new Date(ms + SCHEDULE_UTC_OFFSET_MIN * MINUTE);
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

export function clockText(ms: number): string {
  const { hour, minute } = clockParts(ms);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The instant the agent machine's day containing `ms` started. */
export function dayStart(ms: number): number {
  const offset = SCHEDULE_UTC_OFFSET_MIN * MINUTE;
  return Math.floor((ms + offset) / DAY) * DAY - offset;
}

export function inQuiet(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** A recorded run belongs to a slot when it started within this window around it. */
const MATCH_BEFORE = 3 * MINUTE;
const MATCH_AFTER = 50 * MINUTE;
const RUNNING_LIMIT = 2 * HOUR;

interface AgentSlotState {
  status: SlotStatus;
  note?: string;
}

/**
 * Every slot from the start of `fromDay` for `days` days, with a status.
 * Past slots are judged from recorded runs; future ones are predicted with the
 * agents' own skip rules (quiet hours, minimum interval, pause).
 */
export function buildSchedule(input: {
  now: number;
  settings: ScheduleSettings;
  runs: RunRecord[];
  fromDay?: number;
  days?: number;
}): Slot[] {
  const { now, settings, runs } = input;
  const from = input.fromDay ?? dayStart(now);
  const days = input.days ?? 2;

  const slots: Slot[] = [];
  for (const job of JOBS) {
    const times: number[] = [];
    for (let day = 0; day < days; day++) {
      for (const hour of job.hours(settings)) times.push(from + day * DAY + hour * HOUR + job.minute * MINUTE);
    }
    times.sort((a, b) => a - b);

    const perAgent = job.agents.map((agent) => judgeAgent(agent, job, times, now, settings, runs));
    times.forEach((at, index) => {
      const states = perAgent.map((list) => list[index]);
      slots.push({ kind: job.kind, job, at, time: clockText(at), ...combine(states) });
    });
  }

  slots.sort((a, b) => a.at - b.at || JOBS.indexOf(a.job) - JOBS.indexOf(b.job));
  const next = slots.find((slot) => slot.status === "upcoming");
  if (next !== undefined) next.status = "next";
  return slots;
}

function judgeAgent(
  agent: AgentId,
  job: JobDef,
  times: number[],
  now: number,
  settings: ScheduleSettings,
  allRuns: RunRecord[],
): AgentSlotState[] {
  const runs = allRuns.filter((run) => run.agent === agent).sort((a, b) => a.startedAt - b.startedAt);
  const gap = job.gapMs?.(settings);
  let last = 0;
  const latestBefore = (limit: number) => {
    for (const run of runs) if (run.startedAt <= limit && run.startedAt > last) last = run.startedAt;
  };

  return times.map((at) => {
    const quiet = job.quiet && inQuiet(clockParts(at).hour, settings.quietFrom, settings.quietTo);
    if (at <= now) {
      const match = runs.find((run) => run.startedAt >= at - MATCH_BEFORE && run.startedAt <= at + MATCH_AFTER);
      latestBefore(at - MATCH_BEFORE);
      if (match !== undefined) {
        last = Math.max(last, match.startedAt);
        if (match.finishedAt === undefined) {
          return now - match.startedAt < RUNNING_LIMIT ? { status: "running" } : { status: "failed", note: "never finished" };
        }
        return match.ok === false ? { status: "failed" } : { status: "done" };
      }
      if (quiet) return { status: "quiet" };
      if (gap !== undefined && last > 0 && at - last < gap) return { status: "skip", note: job.gapReason };
      return { status: "missed", note: "no run recorded" };
    }
    latestBefore(now);
    if (settings.paused) return { status: "paused" };
    if (quiet) return { status: "quiet" };
    if (gap !== undefined && last > 0 && at - last < gap) return { status: "skip", note: job.gapReason };
    last = at;
    return { status: "upcoming" };
  });
}

/** One status for a slot that covers several agents (scoring runs two tracks). */
function combine(states: AgentSlotState[]): { status: SlotStatus; note?: string } {
  if (states.length === 1) return states[0];
  const has = (status: SlotStatus) => states.some((state) => state.status === status);
  const ranCount = states.filter((state) => state.status === "done" || state.status === "failed" || state.status === "running").length;
  const partial = ranCount > 0 && ranCount < states.length ? `${ranCount} of ${states.length} tracks` : undefined;
  if (has("running")) return { status: "running", note: partial };
  if (has("failed")) return { status: "failed", note: partial };
  if (has("done")) return { status: "done", note: partial };
  if (has("upcoming")) return { status: "upcoming" };
  return states[0];
}

/** "in 23 min", "in 2 h 5 min". */
export function untilText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}
