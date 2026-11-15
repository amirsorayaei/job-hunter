"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { CalendarClock, CircleAlert, CircleCheck, Globe, Inbox, Loader2, Moon, PauseCircle, Rocket, ScanSearch, SkipForward, FileText } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Section } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import {
  buildSchedule,
  clockParts,
  clockText,
  dayStart,
  JOBS,
  SCHEDULE_TZ_LABEL,
  untilText,
  type JobKind,
  type RunRecord,
  type ScheduleSettings,
  type Slot,
  type SlotStatus,
} from "@/lib/agentSchedule";

const DAY = 24 * 60 * 60 * 1000;

/** One colour per job, used for its dot, its icon tile and its row in the day strip. */
const KIND_STYLE: Record<JobKind, { dot: string; tile: string; icon: typeof Inbox }> = {
  collect: { dot: "bg-sky-400", tile: "bg-sky-500/15 text-sky-300", icon: Inbox },
  score: { dot: "bg-violet-400", tile: "bg-violet-500/15 text-violet-300", icon: ScanSearch },
  explore: { dot: "bg-amber-400", tile: "bg-amber-500/15 text-amber-300", icon: Globe },
  prep: { dot: "bg-emerald-400", tile: "bg-emerald-500/15 text-emerald-300", icon: FileText },
  startups: { dot: "bg-pink-400", tile: "bg-pink-500/15 text-pink-300", icon: Rocket },
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The Schedule page's "Agent schedule": live data from Convex, rendered by the view below. */
export function AgentScheduleSection() {
  const settings = useQuery(api.settings.get, {});
  const recent = useQuery(api.runs.recent, {});
  const now = useNow(20_000);
  if (settings === undefined || recent === undefined) {
    return (
      <Section title="Agent schedule">
        <p className="text-muted-foreground">Loading…</p>
      </Section>
    );
  }
  return <AgentScheduleView now={now} settings={settings} runs={recent.flatMap((item) => item.runs)} />;
}

export function AgentScheduleView({ now, settings, runs }: { now: number; settings: ScheduleSettings; runs: RunRecord[] }) {
  const [day, setDay] = useState<"today" | "tomorrow">("today");
  const slots = useMemo(() => buildSchedule({ now, settings, runs, fromDay: dayStart(now), days: 3 }), [now, settings, runs]);
  const todayStart = dayStart(now);
  const today = slots.filter((slot) => slot.at >= todayStart && slot.at < todayStart + DAY);
  const tomorrow = slots.filter((slot) => slot.at >= todayStart + DAY && slot.at < todayStart + 2 * DAY);
  const next = slots.find((slot) => slot.status === "next");
  const running = slots.filter((slot) => slot.status === "running");
  const afterNext = next === undefined ? [] : slots.filter((slot) => slot.at >= next.at && slot !== next && slot.status === "upcoming").slice(0, 3);
  const shown = day === "today" ? today : tomorrow;
  const claudeRuns = (list: Slot[]) => list.filter((slot) => slot.kind !== "collect" && ["done", "failed", "running", "next", "upcoming"].includes(slot.status)).length;

  return (
    <Section
      title="Agent schedule"
      description={`When each agent runs, on the agent laptop's clock (${SCHEDULE_TZ_LABEL}). Updates live; past slots show what really happened.`}
    >
      <div className="flex flex-col gap-5">
        {settings.paused && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <PauseCircle className="size-4 shrink-0" />
            Agents are paused. Nothing below runs until you switch them on in Settings.
          </div>
        )}

        <NextUp now={now} next={next} running={running} afterNext={afterNext} />

        <DayStrip now={now} slots={today} settings={settings} />

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div role="tablist" aria-label="Day" className="inline-flex rounded-lg border bg-muted/30 p-0.5">
              {(["today", "tomorrow"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={day === value}
                  onClick={() => setDay(value)}
                  className={cn(
                    "h-8 min-w-24 rounded-md px-3 text-xs font-medium capitalize transition-colors",
                    day === value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {claudeRuns(shown)} Claude run{claudeRuns(shown) === 1 ? "" : "s"} {day === "today" ? "today" : "tomorrow"} · quiet {pad(settings.quietFrom)}:00 to {pad(settings.quietTo)}:00
            </p>
          </div>
          <SlotList now={now} slots={shown} />
        </div>
      </div>
    </Section>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ── Next run, the thing to see first ─────────────────────────────────────

function NextUp({ now, next, running, afterNext }: { now: number; next: Slot | undefined; running: Slot[]; afterNext: Slot[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="relative overflow-hidden rounded-xl border border-primary/50 bg-primary/10 p-4">
        {next === undefined ? (
          <div className="flex items-center gap-3">
            <JobTile kind="collect" muted />
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Next run</p>
              <p className="font-medium">Nothing scheduled in the next two days</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <JobTile kind={next.kind} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                Next run
              </p>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <p className="text-base font-semibold">{next.job.label}</p>
                <p className="font-heading text-2xl font-semibold tabular-nums">{next.time}</p>
                <p className="text-sm text-foreground/80 tabular-nums">{untilText(next.at - now)}</p>
              </div>
              <p className="text-xs text-muted-foreground">{next.job.detail}</p>
              {afterNext.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.6875rem] text-muted-foreground">Then</span>
                  {afterNext.map((slot) => (
                    <span key={`${slot.kind}-${slot.at}`} className="inline-flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-[0.6875rem] ring-1 ring-border">
                      <span className={cn("size-1.5 rounded-full", KIND_STYLE[slot.kind].dot)} />
                      <span className="tabular-nums">{slot.time}</span>
                      <span className="text-muted-foreground">{slot.job.label}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 rounded-xl border bg-muted/20 p-4 md:min-w-44 md:flex-col md:items-start md:justify-center md:gap-1">
        <CalendarClock className="size-5 text-muted-foreground md:hidden" />
        <p className="text-xs text-muted-foreground">Now, {SCHEDULE_TZ_LABEL}</p>
        <p className="ms-auto font-heading text-xl font-semibold tabular-nums md:ms-0">{clockText(now)}</p>
        {running.length > 0 && (
          <p className="flex w-full items-center gap-1.5 text-xs text-sky-300">
            <Loader2 className="size-3.5 animate-spin" />
            {running.map((slot) => slot.job.label).join(", ")} running
          </p>
        )}
      </div>
    </div>
  );
}

function JobTile({ kind, muted }: { kind: JobKind; muted?: boolean }) {
  const Icon = KIND_STYLE[kind].icon;
  return (
    <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", muted ? "bg-muted text-muted-foreground" : KIND_STYLE[kind].tile)}>
      <Icon className="size-5" />
    </span>
  );
}

// ── The day at a glance (wide screens) ───────────────────────────────────

function DayStrip({ now, slots, settings }: { now: number; slots: Slot[]; settings: ScheduleSettings }) {
  const nowPos = position(now);
  const quietBands =
    settings.quietFrom === settings.quietTo
      ? []
      : settings.quietFrom < settings.quietTo
        ? [[settings.quietFrom, settings.quietTo]]
        : [
            [settings.quietFrom, 24],
            [0, settings.quietTo],
          ];
  return (
    <div className="hidden rounded-xl border bg-muted/10 p-4 md:block" aria-hidden>
      <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-3">
        <div />
        <div className="relative mb-1 h-4 text-[0.625rem] text-muted-foreground tabular-nums">
          {Array.from({ length: 9 }, (_, index) => index * 3).map((hour) => (
            <span key={hour} className="absolute -translate-x-1/2" style={{ left: `${(hour / 24) * 100}%` }}>
              {pad(hour % 24 === 0 && hour > 0 ? 24 : hour)}
            </span>
          ))}
        </div>
        {JOBS.map((job) => {
          const row = slots.filter((slot) => slot.kind === job.kind);
          return (
            <div key={job.kind} className="contents">
              <div className="flex h-8 items-center gap-2 text-xs">
                <span className={cn("size-2 shrink-0 rounded-full", KIND_STYLE[job.kind].dot)} />
                <span className="truncate">{job.label}</span>
              </div>
              <div className="relative h-8 border-t border-border/60">
                {quietBands.map(([from, to]) => (
                  <div
                    key={from}
                    className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(148,163,184,0.08)_4px_8px)]"
                    style={{ left: `${(from / 24) * 100}%`, width: `${((to - from) / 24) * 100}%` }}
                  />
                ))}
                {row.length === 0 && <span className="absolute inset-y-0 left-1 flex items-center text-[0.625rem] text-muted-foreground">not scheduled</span>}
                {row.map((slot) => (
                  <span
                    key={slot.at}
                    title={`${slot.time} · ${STATUS[slot.status].label}`}
                    className={cn("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full", markerClass(slot))}
                    style={{ left: `${position(slot.at) * 100}%` }}
                  />
                ))}
                <div className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: `${nowPos * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 ps-[9.5rem] text-[0.625rem] text-muted-foreground">
        <Legend className="size-2.5 bg-foreground/80">ran</Legend>
        <Legend className="size-3 ring-2 ring-primary">next</Legend>
        <Legend className="size-2.5 ring-1 ring-foreground/60">scheduled</Legend>
        <Legend className="size-2 bg-foreground/20">skipped or quiet</Legend>
        <Legend className="size-2.5 ring-1 ring-amber-400">no run</Legend>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-px bg-primary" /> now
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgba(148,163,184,0.25)_3px_6px)]" /> quiet hours
        </span>
      </div>
    </div>
  );
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block rounded-full", className)} />
      {children}
    </span>
  );
}

/** Fraction of the day (0..1) on the agent machine's clock. */
function position(ms: number): number {
  const { hour, minute } = clockParts(ms);
  return (hour * 60 + minute) / (24 * 60);
}

function markerClass(slot: Slot): string {
  const dot = KIND_STYLE[slot.kind].dot;
  switch (slot.status) {
    case "done":
      return cn("size-2.5", dot);
    case "running":
      return cn("size-3 animate-pulse", dot);
    case "failed":
      return "size-2.5 bg-destructive";
    case "next":
      return cn("size-3 ring-2 ring-primary ring-offset-2 ring-offset-background", dot);
    case "upcoming":
      return "size-2.5 ring-1 ring-foreground/60 bg-background";
    case "missed":
      return "size-2.5 ring-1 ring-amber-400 bg-background";
    default:
      return "size-2 bg-foreground/20";
  }
}

// ── The full list ────────────────────────────────────────────────────────

const STATUS: Record<SlotStatus, { label: string; className: string; icon?: typeof Moon }> = {
  done: { label: "Done", className: "bg-emerald-500/10 text-emerald-400", icon: CircleCheck },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive", icon: CircleAlert },
  running: { label: "Running", className: "bg-sky-500/10 text-sky-300", icon: Loader2 },
  missed: { label: "No run", className: "bg-amber-500/10 text-amber-300" },
  next: { label: "Next", className: "bg-primary text-primary-foreground" },
  upcoming: { label: "Scheduled", className: "bg-muted text-foreground/80" },
  quiet: { label: "Quiet hours", className: "text-muted-foreground", icon: Moon },
  skip: { label: "Skips", className: "text-muted-foreground", icon: SkipForward },
  paused: { label: "Paused", className: "bg-amber-500/10 text-amber-300", icon: PauseCircle },
};

/** Past slots kept visible above "now" before the rest fold away. */
const PAST_KEPT = 3;

function SlotList({ now, slots }: { now: number; slots: Slot[] }) {
  const [showEarlier, setShowEarlier] = useState(false);
  if (slots.length === 0) return <p className="py-2 text-xs text-muted-foreground">Nothing scheduled.</p>;
  const firstFuture = slots.findIndex((slot) => slot.at > now || slot.status === "running");
  const pastCount = firstFuture === -1 ? slots.length : firstFuture;
  const hidden = showEarlier ? 0 : Math.max(0, pastCount - PAST_KEPT);
  const visible = slots.slice(hidden);
  return (
    <ol className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border">
      {(hidden > 0 || (showEarlier && pastCount > PAST_KEPT)) && (
        <li>
          <button
            type="button"
            onClick={() => setShowEarlier(!showEarlier)}
            className="flex w-full items-center justify-center gap-1.5 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
          >
            {showEarlier ? "Hide earlier slots" : `Show ${hidden} earlier slot${hidden === 1 ? "" : "s"} today`}
          </button>
        </li>
      )}
      {visible.map((slot) => {
        const past = slot.at <= now && slot.status !== "running";
        const status = STATUS[slot.status];
        const Icon = status.icon;
        const quietish = slot.status === "quiet" || slot.status === "skip";
        return (
          <li
            key={`${slot.kind}-${slot.at}`}
            aria-current={slot.status === "next" ? "true" : undefined}
            className={cn(
              "grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:px-4",
              slot.status === "next" && "relative bg-primary/10 before:absolute before:inset-y-0 before:start-0 before:w-1 before:bg-primary",
              slot.status === "running" && "bg-sky-500/5",
              past && "opacity-60",
              quietish && !past && "opacity-70",
            )}
          >
            <span className={cn("font-heading text-sm tabular-nums", slot.status === "next" ? "font-semibold" : "text-foreground/90")}>{slot.time}</span>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={cn("size-2 shrink-0 rounded-full", KIND_STYLE[slot.kind].dot, quietish && "opacity-40")} />
              <div className="min-w-0">
                <p className={cn("truncate text-sm", slot.status === "next" && "font-medium", quietish && "text-muted-foreground")}>{slot.job.label}</p>
                <p className="truncate text-[0.6875rem] text-muted-foreground">
                  {slot.note !== undefined && (slot.status === "skip" || slot.status === "missed" || slot.note.includes("tracks")) ? slot.note : slot.job.detail}
                </p>
              </div>
            </div>
            <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap tabular-nums", status.className)}>
              {Icon !== undefined && <Icon className={cn("size-3", slot.status === "running" && "animate-spin")} />}
              {status.label}
              {slot.status === "next" && <span className="hidden font-normal opacity-90 sm:inline">· {untilText(slot.at - now)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
