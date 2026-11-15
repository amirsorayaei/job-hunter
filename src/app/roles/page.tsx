"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ArrowDownWideNarrow, Check, ExternalLink, Mail, Search, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import { OwnerGate } from "@/components/OwnerGate";
import { PageShell } from "@/components/PageShell";
import { RoleDrawer } from "@/components/roles/RoleDrawer";
import { ScoreBadge, StageBadge } from "@/components/roles/badges";
import { Button } from "@/components/ui/button";
import { GmailLink } from "@/components/GmailLink";
import { NotWorthIt } from "@/components/roles/NotWorthIt";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { friendlyError } from "@/lib/convexError";
import { nextStep, relativeDayTime, TRACK_LABEL, WORK_MODE_LABEL, type Stage } from "@/lib/roleView";
import { cn } from "@/lib/utils";

type View = "new" | "apply" | "progress" | "closed" | "dismissed" | "all";

const VIEWS: Array<{ id: View; label: string; stages: Stage[] | null; hint: string }> = [
  { id: "new", label: "New", stages: ["new"], hint: "Found by the agents, waiting for you to prepare or dismiss." },
  { id: "apply", label: "To apply", stages: ["preparing", "ready"], hint: "Prepared. Email drafts wait in Gmail; form roles need you to apply, then tick Applied." },
  { id: "progress", label: "In progress", stages: ["applied", "replied", "interview"], hint: "Sent or applied, and still open." },
  { id: "closed", label: "Closed", stages: ["offer", "rejected", "no_response"], hint: "Finished one way or another." },
  { id: "dismissed", label: "Dismissed", stages: ["dismissed"], hint: "Roles you passed on. Restore any from its panel." },
  { id: "all", label: "All", stages: null, hint: "Everything except dismissed." },
];

type SortKey = "action" | "preparing" | "score" | "found";

const SORT_LABEL: Record<SortKey, string> = {
  action: "Needs me first",
  preparing: "Preparing first",
  score: "Best score",
  found: "Newest",
};

/** Sorts that only make sense while a role is being prepared or waiting to be sent. */
const APPLY_ONLY: SortKey[] = ["action", "preparing"];

function defaultSort(view: View): SortKey {
  if (view === "new") return "score";
  if (view === "apply") return "action";
  return "found";
}

type Row = FunctionReturnType<typeof api.roles.list>[number];

/** Lower comes first: things he can act on now, then things already handled, then the agent's queue. */
function actionRank(role: Row): number {
  if (role.stage === "ready") {
    if (role.applyKind === "form") return 0;
    if (role.hasDraft && role.scheduledInGmail !== true) return 1;
    if (role.scheduledInGmail === true) return 3;
    return 2;
  }
  if (role.stage === "preparing") {
    if (role.prepState === "failed") return 4;
    if (role.prepState === "working") return 5;
    return 6;
  }
  return 7;
}

function preparingRank(role: Row): number {
  if (role.stage === "preparing") {
    if (role.prepState === "working") return 0;
    if (role.prepState === "queued") return 1;
    return 2;
  }
  return 3 + actionRank(role);
}

function RolesTable() {
  const router = useRouter();
  const params = useSearchParams();
  const view = (VIEWS.find((item) => item.id === params.get("view"))?.id ?? "new") as View;
  const roles = useQuery(api.roles.list, {});
  const prepare = useMutation(api.roles.prepare);
  const dismiss = useMutation(api.roles.dismiss);
  const setStage = useMutation(api.roles.setStage);

  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState("all");
  const [kind, setKind] = useState("all");
  const [where, setWhere] = useState("all");
  const [minScore, setMinScore] = useState("0");
  const [sort, setSort] = useState<SortKey | null>(null);
  const [openId, setOpenId] = useState<Id<"roles"> | null>(null);

  const sortKey: SortKey = sort !== null && (view === "apply" || !APPLY_ONLY.includes(sort)) ? sort : defaultSort(view);
  const sortOptions = (Object.keys(SORT_LABEL) as SortKey[])
    .filter((key) => view === "apply" || !APPLY_ONLY.includes(key))
    .map((key): [string, string] => [key, SORT_LABEL[key]]);

  const counts = useMemo(() => {
    const map = new Map<View, number>();
    for (const item of VIEWS) {
      map.set(
        item.id,
        (roles ?? []).filter((role) =>
          item.stages === null ? role.stage !== "dismissed" : item.stages.includes(role.stage),
        ).length,
      );
    }
    return map;
  }, [roles]);

  const visible = useMemo(() => {
    const spec = VIEWS.find((item) => item.id === view)!;
    const needle = query.trim().toLowerCase();
    const rows = (roles ?? []).filter((role) => {
      if (spec.stages === null ? role.stage === "dismissed" : !spec.stages.includes(role.stage)) return false;
      if (track !== "all" && role.track !== track) return false;
      if (kind !== "all" && role.applyKind !== kind) return false;
      if (where !== "all" && role.workMode !== where) return false;
      if (role.score < Number(minScore)) return false;
      if (needle !== "" && !`${role.company} ${role.title} ${role.remoteWording}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const byScore = (a: Row, b: Row) => b.score - a.score || b.foundAt - a.foundAt;
    return rows.sort((a, b) => {
      if (sortKey === "action") return actionRank(a) - actionRank(b) || byScore(a, b);
      if (sortKey === "preparing") return preparingRank(a) - preparingRank(b) || byScore(a, b);
      if (sortKey === "score") return byScore(a, b);
      return (b.appliedAt ?? b.foundAt) - (a.appliedAt ?? a.foundAt);
    });
  }, [roles, view, query, track, kind, where, minScore, sortKey]);

  const act = (label: string, action: () => Promise<unknown>) => {
    void action()
      .then(() => toast.success(label))
      .catch((error: unknown) => toast.error(friendlyError(error)));
  };

  const spec = VIEWS.find((item) => item.id === view)!;

  return (
    <>
      <div className="flex flex-col gap-4">
        {/* View tabs */}
        <div role="tablist" aria-label="Role views" className="flex flex-wrap gap-1 rounded-lg bg-muted/40 p-1">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === view}
              onClick={() => router.replace(`/roles?view=${item.id}`, { scroll: false })}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                item.id === view ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              <span className="tabular-nums text-[0.6875rem] text-muted-foreground">{counts.get(item.id) ?? 0}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{spec.hint}</p>

        {/* Filters, one row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search company, title, location"
              className="ps-8"
              aria-label="Search roles"
            />
          </div>
          <FilterSelect label="Track" value={track} onChange={setTrack} options={[["all", "All tracks"], ["frontend", "Frontend"], ["fullstack", "Full-Stack"]]} />
          <FilterSelect label="Apply by" value={kind} onChange={setKind} options={[["all", "Email or form"], ["email", "Email"], ["form", "Form"]]} />
          <FilterSelect label="Where" value={where} onChange={setWhere} options={[["all", "Anywhere"], ["remote", "Remote"], ["visa", "Visa / relocation"], ["turkey", "Turkey"]]} />
          <FilterSelect label="Score" value={minScore} onChange={setMinScore} options={[["0", "Any score"], ["65", "65+"], ["80", "80+"]]} />
          <FilterSelect label="Sort" value={sortKey} onChange={(value) => setSort(value as SortKey)} options={sortOptions} />
        </div>

        {/* Phones: one card per role, actions always visible. */}
        <ul className="flex flex-col gap-2 md:hidden">
          {roles === undefined && <li className="py-8 text-center text-sm text-muted-foreground">Loading…</li>}
          {roles !== undefined && visible.length === 0 && (
            <li className="py-10 text-center text-sm text-muted-foreground">Nothing here yet.</li>
          )}
          {visible.map((role) => (
            <li key={role._id} className="rounded-xl border bg-card p-3" onClick={() => setOpenId(role._id)}>
              <div className="flex items-start gap-3">
                <ScoreBadge score={role.score} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug font-medium">{role.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {role.company} · {TRACK_LABEL[role.track]} · {WORK_MODE_LABEL[role.workMode]}
                  </p>
                  {nextStep(role) !== "" && (
                    <p className={cn("mt-1 text-xs", role.scheduledInGmail === true ? "text-sky-300" : "text-muted-foreground")}>{nextStep(role)}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <StageBadge stage={role.stage} />
                    <span className="text-[0.6875rem] text-muted-foreground">{relativeDayTime(role.appliedAt ?? role.foundAt, now)}</span>
                    {role.knownCompany === true && (
                      <span className="rounded bg-amber-500/10 px-1 text-[0.625rem] text-amber-300">contacted before</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
                {role.stage === "new" && (
                  <>
                    <Button size="lg" className="flex-1" onClick={() => act("Queued for the prep agent", () => prepare({ roleId: role._id, now: Date.now() }))}>
                      <Sparkles /> Prepare
                    </Button>
                    <NotWorthIt onDismiss={(reason) => act("Moved to Dismissed", () => dismiss({ roleId: role._id, reason, now: Date.now() }))} />
                  </>
                )}
                {role.stage === "ready" && role.applyKind === "form" && (
                  <>
                    <Button asChild size="lg" variant="outline" className="flex-1">
                      <a href={role.url} target="_blank" rel="noreferrer">
                        <ExternalLink /> Open form
                      </a>
                    </Button>
                    <Button size="lg" className="flex-1" onClick={() => act("Marked as applied", () => setStage({ roleId: role._id, stage: "applied", now: Date.now() }))}>
                      <Check /> Applied
                    </Button>
                  </>
                )}
                {role.stage === "ready" && role.applyKind === "email" && role.hasDraft && (
                  <Button asChild size="lg" variant="outline" className="flex-1">
                    <GmailLink>
                      <Mail /> Open Gmail drafts
                    </GmailLink>
                  </Button>
                )}
                {(role.stage === "ready" || role.stage === "preparing") && (
                  <NotWorthIt onDismiss={(reason) => act("Moved to Dismissed", () => dismiss({ roleId: role._id, reason, now: Date.now() }))} />
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="hidden overflow-x-auto rounded-lg border md:block">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="w-14">
                  <SortButton active={sortKey === "score"} onClick={() => setSort("score")}>
                    Score
                  </SortButton>
                </TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden lg:table-cell">Where</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">
                  <SortButton active={sortKey === "found"} onClick={() => setSort("found")}>
                    {view === "progress" || view === "closed" ? "Applied" : "Found"}
                  </SortButton>
                </TableHead>
                <TableHead className="text-end">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles === undefined && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {roles !== undefined && visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                    Nothing here{query !== "" || track !== "all" || kind !== "all" || where !== "all" || minScore !== "0" ? " with these filters" : " yet"}.
                  </TableCell>
                </TableRow>
              )}
              {visible.map((role) => (
                <TableRow key={role._id} className="cursor-pointer" onClick={() => setOpenId(role._id)}>
                  <TableCell>
                    <ScoreBadge score={role.score} />
                  </TableCell>
                  <TableCell className="max-w-[16rem] xl:max-w-[24rem]">
                    <div className="truncate font-medium" title={role.title}>
                      {role.title}
                    </div>
                    <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <span className="truncate">{role.company}</span>
                      <span aria-hidden>·</span>
                      <span>{TRACK_LABEL[role.track]}</span>
                      {role.knownCompany === true && (
                        <span className="rounded bg-amber-500/10 px-1 text-[0.625rem] text-amber-300" title="You contacted this company before, for a different role">
                          contacted before
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-[14rem] lg:table-cell">
                    <div className="text-xs">{WORK_MODE_LABEL[role.workMode]}</div>
                    <div className="truncate text-xs text-muted-foreground" title={role.remoteWording}>
                      {role.remoteWording}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <StageBadge stage={role.stage} />
                      <span className={cn("max-w-[14rem] truncate text-[0.6875rem]", role.scheduledInGmail === true ? "text-sky-300" : "text-muted-foreground")} title={nextStep(role)}>{nextStep(role)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                    {relativeDayTime(role.appliedAt ?? role.foundAt, now)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-end" onClick={(event) => event.stopPropagation()}>
                    <div className="inline-flex items-center gap-1">
                      {role.stage === "new" && (
                        <>
                          <Button size="sm" onClick={() => act("Queued for the prep agent", () => prepare({ roleId: role._id, now: Date.now() }))}>
                            <Sparkles /> Prepare
                          </Button>
                          <NotWorthIt variant="icon" onDismiss={(reason) => act("Moved to Dismissed", () => dismiss({ roleId: role._id, reason, now: Date.now() }))} />
                        </>
                      )}
                      {role.stage === "ready" && role.applyKind === "form" && (
                        <>
                          <Button asChild size="sm" variant="outline">
                            <a href={role.url} target="_blank" rel="noreferrer">
                              <ExternalLink /> Form
                            </a>
                          </Button>
                          <Button size="sm" onClick={() => act("Marked as applied", () => setStage({ roleId: role._id, stage: "applied", now: Date.now() }))}>
                            <Check /> Applied
                          </Button>
                        </>
                      )}
                      {role.stage === "ready" && role.applyKind === "email" && role.hasDraft && (
                        <Button asChild size="sm" variant="outline">
                          <GmailLink>
                            <Mail /> Gmail
                          </GmailLink>
                        </Button>
                      )}
                      {(role.stage === "ready" || role.stage === "preparing") && (
                        <NotWorthIt variant="icon" onDismiss={(reason) => act("Moved to Dismissed", () => dismiss({ roleId: role._id, reason, now: Date.now() }))} />
                      )}
                      {role.stage !== "new" && !(role.stage === "ready") && (
                        <Button asChild size="icon-sm" variant="ghost" aria-label="Open posting" title="Open posting">
                          <a href={role.url} target="_blank" rel="noreferrer">
                            <ExternalLink />
                          </a>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {visible.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {visible.length} role{visible.length === 1 ? "" : "s"}. Click a row for details.
          </p>
        )}
      </div>
      <RoleDrawer roleId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function SortButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("inline-flex items-center gap-1", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
      {children}
      {active && <ArrowDownWideNarrow className="size-3" />}
    </button>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-8 w-auto min-w-32 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={id} className="text-xs">
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function RolesPage() {
  return (
    <OwnerGate>
      <PageShell title="Roles" wide>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <RolesTable />
        </Suspense>
      </PageShell>
    </OwnerGate>
  );
}
