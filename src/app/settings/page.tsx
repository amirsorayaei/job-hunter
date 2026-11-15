"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Building2, CheckCircle2, CircleAlert, Mail, PauseCircle, PlayCircle, RefreshCw, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { OwnerGate } from "@/components/OwnerGate";
import { PageShell, Section } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STARTUPS_HOUR } from "@/lib/agentSchedule";
import { friendlyError } from "@/lib/convexError";
import { dateTime, relativeDay } from "@/lib/roleView";
import { cn } from "@/lib/utils";

const AGENTS: Record<string, { name: string; when: string }> = {
  collector: { name: "Collector", when: "Every 3 hours at :50 · no tokens" },
  frontend: { name: "Frontend agent", when: "Every 3 hours at :00 · interval set in Automation" },
  fullstack: { name: "Full-Stack agent", when: "Every 3 hours at :00 · interval set in Automation" },
  explore: { name: "Web search", when: "At the chosen hours, :15 · one search covering both tracks" },
  startups: { name: "Startup finder", when: `Every 2 days at ${String(STARTUPS_HOUR).padStart(2, "0")}:00` },
  prep: { name: "Prep agent", when: "Every 3 hours at :30 · no tokens when nothing is queued" },
};

type Model = "opus" | "sonnet" | "haiku";
type Usage = {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
};

function compactCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

function usageText(usage: Usage): string {
  return `${usage.calls} calls · ${compactCount(totalTokens(usage))} tokens · ${compactCount(usage.outputTokens)} written · ~$${usage.costUsd.toFixed(2)}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function useSave() {
  const update = useMutation(api.settings.update);
  return (patch: Omit<Parameters<typeof update>[0], "now">) =>
    void update({ ...patch, now: Date.now() })
      .then(() => toast.success("Saved"))
      .catch((error: unknown) => toast.error(friendlyError(error)));
}

// ── Small building blocks ─────────────────────────────────────────────────

/** One setting: what it is and what it does on the left, the control on the right. */
function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b py-4 first:pt-0 last:border-0 last:pb-0 md:flex-row md:items-center md:gap-8">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function HourSelect({ value, onChange, label }: { value: number; onChange: (hour: number) => void; label: string }) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger className="w-24 tabular-nums" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 24 }, (_, hour) => (
          <SelectItem key={hour} value={String(hour)} className="tabular-nums">
            {String(hour).padStart(2, "0")}:00
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const MODEL_OPTIONS: Array<{ value: Model; label: string }> = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

function ModelPicker({ value, onChange, label }: { value: Model; onChange: (value: Model) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-muted/30 p-0.5">
      {MODEL_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => value !== option.value && onChange(option.value)}
          className={cn(
            "h-8 min-w-20 rounded-md px-3 text-xs font-medium transition-colors",
            value === option.value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <CardContent className="flex h-full items-center gap-4 p-4">{children}</CardContent>
    </Card>
  );
}

function IconTile({ tone, children }: { tone: "good" | "warn" | "neutral"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg",
        tone === "good" && "bg-emerald-500/15 text-emerald-300",
        tone === "warn" && "bg-amber-500/15 text-amber-300",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

// ── Status strip: the three things to check at a glance ──────────────────

function AgentsStatusCard() {
  const settings = useQuery(api.settings.get, {});
  const save = useSave();
  if (settings === undefined) return <StatCard><p className="text-sm text-muted-foreground">Loading…</p></StatCard>;
  return (
    <StatCard>
      <IconTile tone={settings.paused ? "warn" : "good"}>
        {settings.paused ? <PauseCircle className="size-5" /> : <PlayCircle className="size-5" />}
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">Agents</p>
        <p className="font-medium">{settings.paused ? "Paused" : "Running"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {settings.paused ? "Nothing runs until you switch it on" : "Searching every 3 hours, preparing the best"}
        </p>
      </div>
      <Switch checked={!settings.paused} onCheckedChange={(on) => save({ paused: !on })} aria-label="Agents running" />
    </StatCard>
  );
}

function GmailStatusCard() {
  const connection = useQuery(api.gmail.queries.connection, {});
  const syncNow = useAction(api.gmail.node.syncNow);
  const [syncing, setSyncing] = useState(false);
  const [now] = useState(() => Date.now());
  const account = connection?.account ?? null;
  const healthy = account !== null && account.status === "active" && account.canDraft;
  return (
    <StatCard>
      <IconTile tone={healthy ? "good" : "warn"}>{healthy ? <CheckCircle2 className="size-5" /> : <CircleAlert className="size-5" />}</IconTile>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">Gmail</p>
        <p className="truncate font-medium">{connection === undefined ? "…" : account === null ? "Not connected" : healthy ? "Connected" : "Needs reconnect"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {account?.lastSyncAt !== undefined ? `Replies checked ${relativeDay(account.lastSyncAt, now)}, ${clock(account.lastSyncAt)}` : "Drafts only, never sends"}
        </p>
      </div>
      {healthy && (
        <Button
          variant="outline"
          size="sm"
          disabled={syncing}
          onClick={() => {
            setSyncing(true);
            void syncNow({})
              .then((result) =>
                result.error !== undefined
                  ? toast.error(result.error)
                  : toast.success(`Checked ${result.checked} thread${result.checked === 1 ? "" : "s"}${result.followUps > 0 ? `, ${result.followUps} follow-up drafts` : ""}`),
              )
              .catch((error: unknown) => toast.error(friendlyError(error)))
              .finally(() => setSyncing(false));
          }}
        >
          <RefreshCw className={cn(syncing && "animate-spin")} /> Check
        </Button>
      )}
    </StatCard>
  );
}

function TokensStatusCard() {
  const [now] = useState(() => Date.now());
  const usageDay = useQuery(api.runs.usageLastDay, { now });
  const total = usageDay?.total;
  return (
    <StatCard>
      <IconTile tone="neutral">
        <Sparkles className="size-5" />
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">Claude tokens, last 24 hours</p>
        {total === undefined ? (
          <p className="font-medium">…</p>
        ) : total.calls === 0 ? (
          <>
            <p className="font-medium">Nothing yet</p>
            <p className="text-xs text-muted-foreground">Counted from the next run</p>
          </>
        ) : (
          <>
            <p className="font-medium tabular-nums">
              {compactCount(totalTokens(total))} <span className="text-xs font-normal text-muted-foreground">in {total.calls} calls</span>
            </p>
            <p className="truncate text-xs text-muted-foreground tabular-nums">
              {compactCount(total.outputTokens)} written by the model · ~${total.costUsd.toFixed(2)} at API prices
            </p>
          </>
        )}
      </div>
    </StatCard>
  );
}

// ── Left column: what you tune ────────────────────────────────────────────

function AutomationSection() {
  const settings = useQuery(api.settings.get, {});
  const save = useSave();
  const [cap, setCap] = useState<string | null>(null);
  if (settings === undefined) return null;
  return (
    <Section title="Automation" description="When the agents work, how many roles they prepare without you, and which ones you see.">
      <SettingRow
        label="Quiet hours"
        hint="No Claude work inside this range (scoring, web search, prep, company and startup finders). The collector keeps reading boards for free, and the first run after it ends catches up. Same hour in both = no quiet time. Agent laptop's clock (Tehran)."
      >
        <div className="flex items-center gap-2">
          <HourSelect label="Quiet from" value={settings.quietFrom} onChange={(hour) => save({ quietFrom: hour })} />
          <span className="text-xs text-muted-foreground">to</span>
          <HourSelect label="Quiet until" value={settings.quietTo} onChange={(hour) => save({ quietTo: hour })} />
        </div>
      </SettingRow>
      <SettingRow label="Score new postings every" hint="Each scoring run has a fixed cost however few postings it reads, so fewer, bigger runs use less of your limit.">
        <Select value={String(settings.scoreEveryHours)} onValueChange={(value) => save({ scoreEveryHours: Number(value) })}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 6, 8, 12].map((hours) => (
              <SelectItem key={hours} value={String(hours)}>
                {hours === 1 ? "hour" : `${hours} hours`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="Prepare automatically from score" hint="Roles at or above this score get a tailored resume (and an email draft when there is an address) without a click.">
        <Select value={String(settings.autoPrepareMinScore)} onValueChange={(value) => save({ autoPrepareMinScore: Number(value) })}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[50, 55, 60, 65, 70, 75, 80, 85, 90].map((score) => (
              <SelectItem key={score} value={String(score)}>
                {score} and above
              </SelectItem>
            ))}
            <SelectItem value="101">Never (I click Prepare)</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Auto-prepare email roles only"
        hint="On: only roles that take applications by email get prepared automatically (resume plus a Gmail draft). Form roles stay in New until you click Prepare."
      >
        <Switch checked={settings.autoPrepareEmailOnly} onCheckedChange={(on) => save({ autoPrepareEmailOnly: on })} aria-label="Auto-prepare email roles only" />
      </SettingRow>
      <SettingRow label="Daily limit" hint="The most roles prepared automatically per day (Istanbul time). Prepare clicks are not limited.">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={100}
            className="w-24 text-end tabular-nums"
            value={cap ?? String(settings.dailyPrepCap)}
            onChange={(event) => setCap(event.target.value)}
            onBlur={() => {
              if (cap !== null && Number(cap) !== settings.dailyPrepCap) save({ dailyPrepCap: Number(cap) });
            }}
            aria-label="Daily limit"
          />
          <span className="text-xs text-muted-foreground">per day</span>
        </div>
      </SettingRow>
      <SettingRow label="Show roles from score" hint="Anything scored lower is hidden from the Roles list.">
        <Select value={String(settings.minScoreToShow)} onValueChange={(value) => save({ minScoreToShow: Number(value) })}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[40, 45, 50, 55, 60, 65, 70].map((score) => (
              <SelectItem key={score} value={String(score)}>
                {score} and above
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </Section>
  );
}

function ModelsSection() {
  const settings = useQuery(api.settings.get, {});
  const save = useSave();
  if (settings === undefined) return null;
  const rows = [
    { key: "scoreModel", label: "Scoring", hint: "Reads new postings in batches." },
    { key: "exploreModel", label: "Web search", hint: `At the hours below, and the Startup finder every 2 days at ${String(STARTUPS_HOUR).padStart(2, "0")}:00.` },
    { key: "companiesModel", label: "Company finder", hint: "Once a day at 12:00." },
    { key: "prepModel", label: "Resume and email prep", hint: "One short call per role." },
  ] as const;
  return (
    <Section title="Models" description="Haiku is the lightest on your Max limit, Opus the heaviest (about twice Sonnet).">
      {rows.map((row) => (
        <SettingRow key={row.key} label={row.label} hint={row.hint}>
          <ModelPicker label={row.label} value={settings[row.key]} onChange={(value) => save({ [row.key]: value })} />
        </SettingRow>
      ))}
    </Section>
  );
}

function ScheduleSection() {
  const settings = useQuery(api.settings.get, {});
  const save = useSave();
  if (settings === undefined) return null;
  const hours = [...settings.exploreHours].sort((a, b) => a - b);
  return (
    <Section
      title="Web search hours"
      description="Local time of the machine running the agents. Each chosen hour runs one open-web search for both tracks, about 30 minutes."
    >
      <p className="mb-3 text-sm">
        {hours.length === 0 ? (
          <span className="text-muted-foreground">No web searches. Only the job boards are read.</span>
        ) : (
          <>
            <span className="font-medium">{hours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")}</span>
            <span className="text-muted-foreground"> · {hours.length} search{hours.length === 1 ? "" : "es"} a day</span>
          </>
        )}
      </p>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
        {Array.from({ length: 24 }, (_, hour) => {
          const on = settings.exploreHours.includes(hour);
          return (
            <button
              key={hour}
              type="button"
              aria-pressed={on}
              onClick={() => save({ exploreHours: on ? settings.exploreHours.filter((item) => item !== hour) : [...settings.exploreHours, hour] })}
              className={cn(
                "h-9 rounded-md border text-xs tabular-nums transition-colors",
                on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {String(hour).padStart(2, "0")}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ── Right column: what is happening ───────────────────────────────────────

function ActivitySection() {
  const runs = useQuery(api.runs.recent, {});
  const [now] = useState(() => Date.now());
  const usageDay = useQuery(api.runs.usageLastDay, { now });
  return (
    <Section title="Agent activity" description="Last run of each agent. Hover a summary to read all of it.">
      <ul className="-my-1 flex flex-col">
        {Object.entries(AGENTS).map(([id, agent]) => {
          const last = runs?.find((item) => item.agent === id)?.runs[0];
          const day = usageDay?.byAgent.find((item) => item.agent === id);
          const running = last !== undefined && last.finishedAt === undefined && now - last.startedAt < 2 * 60 * 60 * 1000;
          const state = last === undefined ? "never" : running ? "running" : last.ok === false ? "failed" : "ok";
          const detail = last?.error ?? last?.summary;
          return (
            <li key={id} className="border-b py-3 last:border-0">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    state === "ok" && "bg-emerald-400",
                    state === "running" && "animate-pulse bg-sky-400",
                    state === "failed" && "bg-destructive",
                    state === "never" && "bg-muted-foreground/40",
                  )}
                />
                <p className="text-sm font-medium">{agent.name}</p>
                <span
                  className={cn(
                    "ms-auto text-xs tabular-nums",
                    state === "failed" ? "text-destructive" : state === "running" ? "text-sky-300" : "text-muted-foreground",
                  )}
                >
                  {last === undefined ? "never ran" : running ? `running since ${clock(last.startedAt)}` : `${state} · ${dateTime(last.startedAt)}`}
                </span>
              </div>
              <p className="ms-4 text-xs text-muted-foreground">{agent.when}</p>
              {detail !== undefined && (
                <p title={detail} className={cn("ms-4 mt-1 line-clamp-2 text-xs", last?.error !== undefined ? "text-destructive" : "text-foreground/80")}>
                  {detail}
                </p>
              )}
              {(last?.usage !== undefined || (day !== undefined && day.runs > 0)) && (
                <p className="ms-4 mt-1 text-[0.6875rem] text-muted-foreground tabular-nums">
                  {last?.usage !== undefined && <>Last run: {usageText(last.usage)}</>}
                  {day !== undefined && day.runs > 1 && <><br />24 h ({day.runs} runs): {usageText(day.usage)}</>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function GmailSection() {
  const params = useSearchParams();
  const connection = useQuery(api.gmail.queries.connection, {});
  const startConnect = useMutation(api.gmail.mutations.startConnect);
  const disconnect = useMutation(api.gmail.mutations.disconnect);
  const updateSignature = useMutation(api.gmail.mutations.updateSignature);
  const [signature, setSignature] = useState<string | null>(null);

  useEffect(() => {
    const result = params.get("gmail");
    if (result === null) return;
    if (result === "connected") toast.success("Gmail connected");
    else if (result === "denied") toast.error("Google sign-in was cancelled");
    else toast.error(result.startsWith("error:") ? result.slice(6) : `Gmail connection ${result}`);
  }, [params]);

  const account = connection?.account ?? null;
  const healthy = account !== null && account.status === "active" && account.canDraft;
  const connect = () =>
    void startConnect({ now: Date.now() })
      .then((url) => window.location.assign(url))
      .catch((error: unknown) => toast.error(friendlyError(error)));

  return (
    <Section title="Gmail" description="Emails and follow-ups become drafts with the resume attached. You schedule them yourself.">
      {connection === undefined ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !connection.configured ? (
        <p className="text-destructive">Google client id/secret are not set on this backend.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-medium">
              {account === null ? "Not connected" : account.email}
              {account !== null && !account.canDraft && <span className="ms-2 text-xs text-amber-300">old permissions</span>}
            </p>
            <Button variant={healthy ? "outline" : "default"} size="sm" onClick={connect}>
              <Mail /> {account === null ? "Connect Gmail" : "Reconnect"}
            </Button>
            {account !== null && account.status === "active" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void disconnect({ now: Date.now() })
                    .then(() => toast.success("Disconnected"))
                    .catch((error: unknown) => toast.error(friendlyError(error)))
                }
              >
                Disconnect
              </Button>
            )}
          </div>
          {account?.lastError !== undefined && <p className="text-xs text-destructive">{account.lastError}</p>}
          {account !== null && account.status === "active" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Signature under every email (saved when you click away)</span>
              <Textarea
                rows={4}
                value={signature ?? account.signature}
                onChange={(event) => setSignature(event.target.value)}
                onBlur={() => {
                  if (signature !== null && signature !== account.signature) {
                    void updateSignature({ signature, now: Date.now() })
                      .then(() => toast.success("Signature saved"))
                      .catch((error: unknown) => toast.error(friendlyError(error)));
                  }
                }}
                className="font-mono text-xs"
              />
            </label>
          )}
        </div>
      )}
    </Section>
  );
}

function CompaniesSection() {
  const summary = useQuery(api.companies.summary, {});
  return (
    <Section title="Company catalog" description="Boards the collector reads every hour for free. Dead boards switch off by themselves.">
      {summary === undefined ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2">
            <Building2 className="size-4 text-muted-foreground" />
            <span className="text-lg font-semibold tabular-nums">{summary.active}</span> active boards
            {summary.inactive > 0 && <span className="text-xs text-muted-foreground">· {summary.inactive} switched off</span>}
          </p>
          {summary.newest.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">Added most recently</p>
              <div className="flex flex-wrap gap-1.5">
                {summary.newest.map((company) => (
                  <span key={company._id} className="rounded-md bg-muted px-2 py-1 text-xs" title={`${company.provider}:${company.slug}, added ${dateTime(company.addedAt)} by ${company.addedBy}`}>
                    {company.name}
                    {company.lastJobCount !== undefined && <span className="ms-1 text-muted-foreground">{company.lastJobCount}</span>}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

export default function SettingsPage() {
  return (
    <OwnerGate>
      <PageShell title="Settings" wide>
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          <div className="grid gap-4 md:grid-cols-3">
            <AgentsStatusCard />
            <GmailStatusCard />
            <TokensStatusCard />
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex flex-col gap-6">
              <AutomationSection />
              <ModelsSection />
              <ScheduleSection />
            </div>
            <div className="flex flex-col gap-6">
              <ActivitySection />
              <Suspense fallback={null}>
                <GmailSection />
              </Suspense>
              <CompaniesSection />
            </div>
          </div>
        </div>
      </PageShell>
    </OwnerGate>
  );
}
