"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FUNNEL_RAMP, percent, VIZ } from "@/lib/roleView";

/**
 * Dashboard charts. Rules from the dataviz guide: one axis per chart, thin
 * bars with rounded data ends, recessive grid, a legend for 2+ series, text in
 * text colours (never the series colour), a tooltip on every mark.
 */

const AXIS_TICK = { fill: VIZ.axis, fontSize: 11 };

function TooltipBox({ title, rows }: { title: string; rows: Array<{ label: string; value: string; color?: string }> }) {
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2 text-muted-foreground">
          {row.color !== undefined && <span className="size-2 rounded-sm" style={{ background: row.color }} />}
          <span>{row.label}</span>
          <span className="ms-auto ps-3 font-medium text-foreground tabular-nums">{row.value}</span>
        </p>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function dayLabel(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]}`;
}

/** Applications sent and replies received, per day. */
function EmptyOverlay({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <p className="rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

export function ActivityChart({ daily }: { daily: Array<{ date: string; applied: number; replied: number }> }) {
  const data = daily.map((day) => ({ ...day, label: dayLabel(day.date) }));
  const empty = daily.every((day) => day.applied === 0 && day.replied === 0);
  return (
    <div className="relative h-56 w-full">
      <EmptyOverlay show={empty}>No applications in this period yet. They appear here once Gmail sends them or you tick Applied.</EmptyOverlay>
      <ResponsiveContainer>
        <BarChart data={data} barGap={2} barCategoryGap="20%" margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} stroke={VIZ.grid} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={18} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            cursor={{ fill: "oklch(1 0 0 / 5%)" }}
            content={({ active, payload }) =>
              active && payload !== undefined && payload.length > 0 ? (
                <TooltipBox
                  title={String(payload[0].payload.label)}
                  rows={[
                    { label: "Applied", value: String(payload[0].payload.applied), color: VIZ.blue },
                    { label: "Replies", value: String(payload[0].payload.replied), color: VIZ.aqua },
                  ]}
                />
              ) : null
            }
          />
          <Bar dataKey="applied" fill={VIZ.blue} radius={[4, 4, 0, 0]} maxBarSize={14} />
          <Bar dataKey="replied" fill={VIZ.aqua} radius={[4, 4, 0, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Roles the agents found per day (one series, so no legend). */
export function FoundChart({ daily }: { daily: Array<{ date: string; found: number }> }) {
  const data = daily.map((day) => ({ ...day, label: dayLabel(day.date) }));
  const empty = daily.every((day) => day.found === 0);
  return (
    <div className="relative h-28 w-full">
      <EmptyOverlay show={empty}>Nothing found in this period.</EmptyOverlay>
      <ResponsiveContainer>
        <BarChart data={data} barCategoryGap="15%" margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            cursor={{ fill: "oklch(1 0 0 / 5%)" }}
            content={({ active, payload }) =>
              active && payload !== undefined && payload.length > 0 ? (
                <TooltipBox
                  title={String(payload[0].payload.label)}
                  rows={[{ label: "Roles found", value: String(payload[0].payload.found), color: VIZ.found }]}
                />
              ) : null
            }
          />
          <Bar dataKey="found" fill={VIZ.found} radius={[3, 3, 0, 0]} maxBarSize={12} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Found → offer, each stage as a bar with its conversion from the stage before. */
export function Funnel({ steps }: { steps: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...steps.map((step) => step.value));
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((step, index) => {
        const previous = index === 0 ? undefined : steps[index - 1].value;
        return (
          <li key={step.label} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-3 text-xs">
            <span className="text-muted-foreground">{step.label}</span>
            <span className="relative h-5 rounded bg-muted/40" title={`${step.label}: ${step.value}`}>
              <span
                className="absolute inset-y-0 start-0 rounded transition-[width] duration-500"
                style={{
                  width: `${Math.max(step.value > 0 ? 2 : 0, (step.value / max) * 100)}%`,
                  background: FUNNEL_RAMP[Math.min(index, FUNNEL_RAMP.length - 1)],
                }}
              />
              <span className="absolute inset-y-0 start-2 flex items-center font-medium tabular-nums text-foreground">
                {step.value}
              </span>
            </span>
            <span className="text-end tabular-nums text-muted-foreground" title="Conversion from the step above">
              {previous === undefined ? "" : percent(step.value, previous)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Where the applications of the period ended up (parts of a whole, ≤ 6 slices). */
export function OutcomeDonut({ slices }: { slices: Array<{ label: string; value: number; color: string }> }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const data = slices.filter((slice) => slice.value > 0);
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row xl:flex-col 2xl:flex-row">
      <div className="relative size-40 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data.length > 0 ? data : [{ label: "none", value: 1, color: "oklch(1 0 0 / 8%)" }]}
              dataKey="value"
              nameKey="label"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive
            >
              {(data.length > 0 ? data : [{ color: "oklch(1 0 0 / 8%)" }]).map((slice, index) => (
                <Cell key={index} fill={slice.color} />
              ))}
            </Pie>
            {data.length > 0 && (
              <Tooltip
                content={({ active, payload }) =>
                  active && payload !== undefined && payload.length > 0 ? (
                    <TooltipBox
                      title={String(payload[0].name)}
                      rows={[
                        {
                          label: "Applications",
                          value: `${String(payload[0].value)} (${percent(Number(payload[0].value), total)})`,
                        },
                      ]}
                    />
                  ) : null
                }
              />
            )}
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">{total}</span>
          <span className="text-[0.6875rem] text-muted-foreground">applied</span>
        </div>
      </div>
      <ul className="flex w-full flex-col gap-1.5 text-xs">
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ background: slice.color }} />
            <span className="whitespace-nowrap text-muted-foreground">{slice.label}</span>
            <span className="ms-auto font-medium tabular-nums">{slice.value}</span>
            <span className="w-10 text-end tabular-nums text-muted-foreground">{percent(slice.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Frontend vs Full-Stack (or email vs form): applied and how many got answers. */
export function CompareBars({
  rows,
}: {
  rows: Array<{ label: string; applied: number; replied: number; interview?: number }>;
}) {
  const data = rows.map((row) => ({ ...row, interview: row.interview ?? 0 }));
  const showInterview = rows.some((row) => row.interview !== undefined);
  const empty = rows.every((row) => row.applied === 0);
  return (
    <div className="relative mt-2 h-44 w-full">
      <EmptyOverlay show={empty}>No applications yet.</EmptyOverlay>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" barGap={2} barCategoryGap="28%" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={VIZ.grid} />
          <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="label" tick={{ ...AXIS_TICK, fill: "oklch(0.92 0 0)" }} tickLine={false} axisLine={false} width={74} />
          <Tooltip
            cursor={{ fill: "oklch(1 0 0 / 5%)" }}
            content={({ active, payload }) => {
              if (!active || payload === undefined || payload.length === 0) return null;
              const row = payload[0].payload as (typeof data)[number];
              return (
                <TooltipBox
                  title={row.label}
                  rows={[
                    { label: "Applied", value: String(row.applied), color: VIZ.blue },
                    { label: "Replied", value: `${row.replied} (${percent(row.replied, row.applied)})`, color: VIZ.aqua },
                    ...(showInterview
                      ? [{ label: "Interview", value: `${row.interview} (${percent(row.interview, row.applied)})`, color: VIZ.interview }]
                      : []),
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="applied" fill={VIZ.blue} radius={[0, 4, 4, 0]} maxBarSize={12} />
          <Bar dataKey="replied" fill={VIZ.aqua} radius={[0, 4, 4, 0]} maxBarSize={12} />
          {showInterview && <Bar dataKey="interview" fill={VIZ.interview} radius={[0, 4, 4, 0]} maxBarSize={12} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
