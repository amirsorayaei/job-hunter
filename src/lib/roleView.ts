/** Labels, tones and formatting shared by the dashboard and the roles list. */

export type Stage =
  | "new"
  | "preparing"
  | "ready"
  | "applied"
  | "replied"
  | "interview"
  | "offer"
  | "rejected"
  | "no_response"
  | "dismissed";

export type Tone = "neutral" | "info" | "good" | "warn" | "bad" | "accent";

export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  preparing: "Preparing",
  ready: "Ready to send",
  applied: "Applied",
  replied: "Replied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  no_response: "No response",
  dismissed: "Dismissed",
};

export const STAGE_TONE: Record<Stage, Tone> = {
  new: "accent",
  preparing: "info",
  ready: "warn",
  applied: "info",
  replied: "good",
  interview: "good",
  offer: "good",
  rejected: "bad",
  no_response: "neutral",
  dismissed: "neutral",
};

export const WORK_MODE_LABEL: Record<string, string> = {
  remote: "Remote",
  visa: "Visa / relocation",
  turkey: "Turkey",
  unclear: "Unclear",
};

export const TRACK_LABEL: Record<string, string> = {
  frontend: "Frontend",
  fullstack: "Full-Stack",
};

/** Validated categorical slots (dataviz reference palette, dark steps). */
export const VIZ = {
  blue: "#3987e5",
  orange: "#d95926",
  aqua: "#199e70",
  violet: "#9085e9",
  /** Interviews: violet, so it never sits next to aqua (validated set blue/aqua/violet). */
  interview: "#9085e9",
  found: "#d95926",
  good: "#0ca30c",
  critical: "#d03b3b",
  grid: "oklch(1 0 0 / 8%)",
  axis: "oklch(0.705 0.015 286.067)",
} as const;

/** Ordinal blue ramp for funnel stages, dark-surface safe (steps 300 → 600). */
export const FUNNEL_RAMP = ["#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab"];

const DAY = 24 * 60 * 60 * 1000;

/** "today", "yesterday", "3 days ago", "12 Nov". */
export function relativeDay(ms: number | undefined, now: number): string {
  if (ms === undefined) return "";
  const days = Math.floor((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return shortDate(ms);
}

/** "today, 14:05" / "yesterday, 09:30" / "3 days ago, 10:00" / "2 Nov, 18:40". */
export function relativeDayTime(ms: number | undefined, now: number): string {
  if (ms === undefined) return "";
  const time = new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${relativeDay(ms, now)}, ${time}`;
}

export function shortDate(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function dateTime(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return "–";
  return `${Math.round((part / whole) * 100)}%`;
}

/** What the owner should do next with a role, in a few words. */
/** Quick reasons for passing on a role; picking one is optional. */
export const DISMISS_REASONS = ["Weak company", "Below my level", "Wrong stack", "Bad terms or location", "Not worth the effort"] as const;

export function nextStep(role: {
  dismissReason?: string;
  stage: Stage;
  applyKind: "email" | "form";
  hasDraft: boolean;
  scheduledInGmail?: boolean;
  scheduledFor?: number;
  emailError?: string;
  prepState: string;
  followUpDraftedAt?: number;
  followUpSentAt?: number;
}): string {
  if (role.stage === "dismissed") return role.dismissReason !== undefined ? `Not worth it: ${role.dismissReason.toLowerCase()}` : "";
  if (role.stage === "new") return role.prepState === "failed" ? "Prep failed: retry or dismiss" : "Review: prepare or dismiss";
  if (role.stage === "preparing") return "Agent is tailoring the resume";
  if (role.stage === "ready") {
    if (role.applyKind === "form") return role.hasDraft ? "Apply on the form, then send the intro draft" : "Apply on the form, then tick Applied";
    if (role.emailError !== undefined) return "Email needs a look";
    if (role.scheduledInGmail === true) {
      return role.scheduledFor !== undefined ? `Scheduled in Gmail for ${dateTime(role.scheduledFor)}` : "Scheduled in Gmail";
    }
    if (role.hasDraft) return "Schedule the draft in Gmail";
    return "Creating Gmail draft";
  }
  if (role.stage === "applied") {
    if (role.followUpDraftedAt !== undefined && role.followUpSentAt === undefined) return "Schedule the follow-up in Gmail";
    if (role.followUpSentAt !== undefined) return "Follow-up sent, waiting";
    return "Waiting for a reply";
  }
  if (role.stage === "replied") return "Answer them";
  if (role.stage === "interview") return "Interviewing";
  return "";
}
