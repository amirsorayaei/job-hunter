import { ToneBadge } from "@/components/PageShell";
import { STAGE_LABEL, STAGE_TONE, WORK_MODE_LABEL, type Stage } from "@/lib/roleView";
import { cn } from "@/lib/utils";

export function StageBadge({ stage }: { stage: Stage }) {
  return <ToneBadge tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</ToneBadge>;
}

/** Score as a small pill: 80+ strong, 65+ good, below that muted. */
export function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 80
      ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
      : score >= 65
        ? "bg-sky-500/15 text-sky-300 ring-sky-500/30"
        : "bg-muted text-muted-foreground ring-border";
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-9 items-center justify-center rounded-md px-1.5 text-xs font-semibold tabular-nums ring-1 ring-inset",
        tone,
      )}
      title={`Match score ${score}/100`}
    >
      {score}
    </span>
  );
}

export function WorkModeBadge({ mode, wording }: { mode: string; wording: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={wording}>
      {WORK_MODE_LABEL[mode] ?? mode}
    </span>
  );
}
