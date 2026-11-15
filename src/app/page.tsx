"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarCheck,
  FileCheck2,
  Hourglass,
  Inbox,
  Mail,
  MessageSquareReply,
  Send,
  Sparkles,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import { OwnerGate } from "@/components/OwnerGate";
import { PageShell } from "@/components/PageShell";
import { ActivityChart, CompareBars, FoundChart, Funnel, Legend, OutcomeDonut } from "@/components/dashboard/charts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { GMAIL_DRAFTS_WEB, GmailLink } from "@/components/GmailLink";
import { percent, relativeDay, shortDate, VIZ } from "@/lib/roleView";
import { cn } from "@/lib/utils";

const DAY = 24 * 60 * 60 * 1000;

const PERIODS = [
  { id: "7", label: "7 days", short: "7d", days: 7 },
  { id: "14", label: "14 days", short: "14d", days: 14 },
  { id: "30", label: "30 days", short: "30d", days: 30 },
  { id: "90", label: "90 days", short: "90d", days: 90 },
  { id: "all", label: "All time", short: "All", days: null },
] as const;

type PeriodId = (typeof PERIODS)[number]["id"];

function Panel({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-sm font-semibold">{title}</h2>
          {hint !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="flex size-7 items-center justify-center rounded-lg" style={{ background: `${accent}22`, color: accent }}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Todo({
  count,
  label,
  hint,
  href,
  gmail,
  icon: Icon,
  urgent,
}: {
  count: number;
  label: string;
  hint: string;
  href: string;
  gmail?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  urgent?: boolean;
}) {
  const body = (
    <>
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          count === 0 ? "bg-muted text-muted-foreground" : urgent === true ? "bg-amber-500/15 text-amber-300" : "bg-primary/20 text-teal-300",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("text-xl font-semibold tabular-nums", count === 0 && "text-muted-foreground")}>{count}</span>
          <span className="truncate text-sm">{label}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </>
  );
  const className = cn(
    "group flex items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:border-foreground/20 hover:bg-muted/30",
    count === 0 && "opacity-60",
  );
  return gmail === true ? (
    <GmailLink className={className}>{body}</GmailLink>
  ) : (
    <Link href={href} className={className}>
      {body}
    </Link>
  );
}

function Dashboard() {
  const [period, setPeriod] = useState<PeriodId>("30");
  // Fixed per visit: queries take `now` as an argument and would otherwise resubscribe every render.
  const [now] = useState(() => Date.now());
  const spec = PERIODS.find((item) => item.id === period)!;
  const since = spec.days === null ? undefined : now - spec.days * DAY;
  const days = spec.days ?? 90;

  const stats = useQuery(api.roles.stats, { now, days, since });
  const gmail = useQuery(api.gmail.queries.connection, {});
  const runs = useQuery(api.runs.recent, {});

  const lastRun = useMemo(() => {
    if (runs === undefined) return undefined;
    const all = runs.flatMap((item) => item.runs);
    return all.sort((a, b) => b.startedAt - a.startedAt)[0];
  }, [runs]);

  if (stats === undefined) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const c = stats.counts;
  const a = stats.attention;
  const replyRate = percent(c.replied, c.applied);
  const interviewRate = percent(c.interview, c.applied);

  const outcomes = [
    { label: "Waiting", value: c.waiting, color: VIZ.blue },
    { label: "Replied", value: Math.max(0, c.replied - c.interview - c.offer), color: VIZ.aqua },
    { label: "Interviews", value: c.interview + c.offer, color: VIZ.interview },
    { label: "Rejected", value: c.rejected, color: VIZ.critical },
    { label: "No response", value: c.noResponse, color: "#6b6b66" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Period + status line */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Period" className="flex gap-1 rounded-lg bg-muted/40 p-1">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === period}
              onClick={() => setPeriod(item.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                item.id === period ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="sm:hidden">{item.short}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {stats.firstAppliedAt !== undefined && <>Applying since {shortDate(stats.firstAppliedAt)} · </>}
          {lastRun !== undefined ? <>Last agent run {relativeDay(lastRun.startedAt, now)}, {new Date(lastRun.startedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</> : "Agents have not run yet"}
          {gmail?.account?.lastSyncAt !== undefined && <> · Gmail checked {new Date(gmail.account.lastSyncAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</>}
        </p>
      </div>

      {gmail !== undefined && (gmail.account === null || gmail.account.status !== "active" || !gmail.account.canDraft) && (
        <Link
          href="/settings"
          className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          <AlertTriangle className="size-4 shrink-0" />
          Gmail is not connected for drafts yet. Connect it in Settings so prepared emails land in your Gmail.
        </Link>
      )}

      {/* What needs you now */}
      <section aria-labelledby="todo" className="flex flex-col gap-3">
        <h2 id="todo" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Needs you
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Todo count={a.draftsInGmail} label="drafts in Gmail" hint={a.scheduledInGmail > 0 ? `${a.scheduledInGmail} already scheduled` : "Schedule them in Gmail"} href={GMAIL_DRAFTS_WEB} gmail icon={Mail} urgent />
          <Todo count={a.formsToApply} label="forms to apply" hint="Apply, then tick Applied" href="/roles?view=apply" icon={FileCheck2} urgent />
          <Todo count={a.followUpsInGmail} label="follow-ups" hint="7 days silent, draft in Gmail" href={GMAIL_DRAFTS_WEB} gmail icon={Send} urgent />
          <Todo count={a.newRoles} label="new roles" hint={a.preparing > 0 ? `${a.preparing} being prepared now` : "Prepare or dismiss"} href="/roles?view=new" icon={Sparkles} />
        </div>
        {(a.blockedEmails > 0 || a.failedPreps > 0) && (
          <p className="text-xs text-amber-300">
            {a.blockedEmails > 0 && `${a.blockedEmails} email${a.blockedEmails === 1 ? "" : "s"} held for a look. `}
            {a.failedPreps > 0 && `${a.failedPreps} preparation${a.failedPreps === 1 ? "" : "s"} failed. `}
            <Link href="/roles?view=apply" className="underline underline-offset-2">
              Open Roles
            </Link>
          </p>
        )}
      </section>

      {/* Headline numbers for the period */}
      <section aria-label="Results" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Applied" value={c.applied} sub={`${c.prepared} prepared`} icon={Send} accent={VIZ.blue} />
        <Kpi label="Waiting" value={c.waiting} sub="no answer yet" icon={Hourglass} accent="#a1a1aa" />
        <Kpi label="Replies" value={c.replied} sub={`${replyRate} reply rate`} icon={MessageSquareReply} accent={VIZ.aqua} />
        <Kpi label="Interviews" value={c.interview} sub={`${interviewRate} of applications`} icon={CalendarCheck} accent={VIZ.interview} />
        <Kpi label="No response" value={c.noResponse} sub={`${c.rejected} rejected`} icon={Inbox} accent={VIZ.critical} />
        <Kpi label="Roles found" value={c.found} sub="by the agents" icon={Sparkles} accent={VIZ.found} />
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Applications and replies"
          hint={`Per day, last ${days} days`}
          action={<Legend items={[{ label: "Applied", color: VIZ.blue }, { label: "Replies", color: VIZ.aqua }]} />}
        >
          <ActivityChart daily={stats.daily} />
        </Panel>
        <Panel title="Where applications stand" hint={spec.days === null ? "All time" : `Applied in the last ${spec.label}`}>
          <OutcomeDonut slices={outcomes} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Pipeline" hint="Roles found in this period, by the furthest step each reached">
          <Funnel steps={stats.funnel.map((row) => ({ label: row.step, value: row.count }))} />
        </Panel>
        <Panel title="Frontend vs Full-Stack" hint="Which track gets answers">
          <Legend items={[{ label: "Applied", color: VIZ.blue }, { label: "Replied", color: VIZ.aqua }, { label: "Interview", color: VIZ.interview }]} />
          <CompareBars
            rows={stats.byTrack.map((row) => ({
              label: row.track === "frontend" ? "Frontend" : "Full-Stack",
              applied: row.applied,
              replied: row.replied,
              interview: row.interview,
            }))}
          />
        </Panel>
        <Panel title="Email vs form" hint="Reply rate by how you applied">
          <Legend items={[{ label: "Applied", color: VIZ.blue }, { label: "Replied", color: VIZ.aqua }]} />
          <CompareBars
            rows={stats.byChannel.map((row) => ({
              label: row.channel === "email" ? "Email" : "Form",
              applied: row.applied,
              replied: row.replied,
            }))}
          />
        </Panel>
      </div>

      <Panel title="Roles found per day" hint="What the agents surfaced (score 50+)">
        <FoundChart daily={stats.daily} />
      </Panel>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <OwnerGate>
      <PageShell title="Dashboard" wide>
        <Dashboard />
      </PageShell>
    </OwnerGate>
  );
}
