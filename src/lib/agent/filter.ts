/**
 * The collector's zero-token filter: which postings are worth a scorer's time.
 *
 * Deliberately generous on the edges: a borderline posting costs a few
 * hundred tokens to score, a wrongly dropped one costs a job. What it removes
 * is the obvious noise: non-developer titles, stacks Candidate does not have, and
 * on-site roles with no remote option, no Turkey location and no visa help.
 */

export type Track = "frontend" | "fullstack";

const DEV_TITLE =
  /\b(front[\s-]?end|full[\s-]?stack|react(\.?js)?|next\.?js|javascript|typescript|node(\.?js)?|web (developer|engineer)|ui (developer|engineer)|software (engineer|developer)|product (engineer|developer)|founding engineer|application (engineer|developer)|design engineer|ai (product |application )?engineer)\b/i;

const NOT_FOR_CANDIDATE =
  /\b(intern(ship)?|working student|werkstudent|trainee|apprentice|graduate|junior|principal|director|head of|vp|vice president|manager|android|ios|swift|kotlin|flutter|react native|mobile|data (engineer|scientist|analyst)|machine learning|ml engineer|research(er)?|devops|platform|infrastructure|cloud|systems|network|sre|site reliability|security|qa|quality|test(ing)?|sdet|embedded|firmware|hardware|salesforce|sap|servicenow|support|sales|designer|recruiter|analyst|java(?!script)|\.net|c#|c\+\+|golang|rust|ruby|rails|php|laravel|angular|scala|elixir|unity|game|blockchain protocol|solidity)\b/i;

/** Is this a developer title Candidate could plausibly hold? */
export function isRelevantTitle(title: string): boolean {
  const clean = title.replace(/[()[\]]/g, " ");
  if (!DEV_TITLE.test(clean)) return false;
  if (NOT_FOR_CANDIDATE.test(clean)) return false;
  // Backend-only titles qualify only when the stack is JavaScript/TypeScript.
  if (/\bback[\s-]?end\b/i.test(clean) && !/\b(node|typescript|javascript|full)/i.test(clean)) return false;
  return true;
}

/** Frontend agent or Full-Stack agent. Anything not clearly frontend goes to Full-Stack. */
export function trackFor(title: string): Track {
  const clean = title.toLowerCase();
  if (/full[\s-]?stack/.test(clean)) return "fullstack";
  if (/front[\s-]?end|\breact\b|\bui (developer|engineer)|design engineer|web (developer|engineer)|javascript|next\.?js/.test(clean)) {
    return "frontend";
  }
  return "fullstack";
}

const REMOTE = /\b(remote|anywhere|worldwide|distributed|work from home|wfh|fully remote)\b/i;
const TURKEY = /\b(turkey|türkiye|turkiye|istanbul|i̇stanbul|ankara|izmir|i̇zmir)\b/i;
const VISA =
  /\b(visa sponsorship|sponsor(ship)? (your |a |the )?(work )?visa|visa support|relocation (support|package|assistance|bonus)|we (will |can )?sponsor|blue card sponsorship|relocate (you|to))\b/i;

export type Placement = "remote" | "turkey" | "visa";

/**
 * Why this posting is reachable for Candidate, or null when it is not.
 *
 * `workplaceType` comes from the ATS when it says so; free text is checked too
 * because many boards only write "Remote" in the location or the JD.
 */
export function placementOf(input: {
  workplaceType?: string;
  location: string;
  title: string;
  description: string;
}): Placement | null {
  const where = `${input.location} ${input.title}`;
  if (TURKEY.test(where)) return "turkey";
  if (input.workplaceType === "remote" || REMOTE.test(where)) return "remote";
  const head = input.description.slice(0, 6000);
  if (VISA.test(head)) return "visa";
  // A JD that says "remote" in its opening paragraphs, with no location given.
  if (input.location.trim() === "" && REMOTE.test(head.slice(0, 1500))) return "remote";
  return null;
}

/** Postings older than this are ignored when the board says when they were posted. */
export const MAX_AGE_DAYS = 45;

export function isFresh(postedAt: string | null | undefined, now: number): boolean {
  if (postedAt === null || postedAt === undefined || postedAt === "") return true;
  const ms = Date.parse(postedAt);
  if (!Number.isFinite(ms)) return true;
  return now - ms <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NOT_A_HIRING_ADDRESS = /(noreply|no-reply|donotreply|privacy|gdpr|dpo|legal|abuse|security|support|billing|press|media|example\.com|sentry|wixpress)/i;

/** Hiring addresses written in the posting itself (the only kind we ever trust). */
export function emailsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0].replace(/\.+$/, "").toLowerCase();
    if (NOT_A_HIRING_ADDRESS.test(address)) continue;
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(address)) continue;
    found.add(address);
  }
  return [...found];
}
