/**
 * The 7-day follow-up draft.
 *
 * Written in the owner's voice rules (CLAUDE.md "Written answers"): short,
 * plain, contractions, no em-dashes, no intensifiers. It claims nothing about
 * skills, so it passes the truthfulness validator on its own. It is a DRAFT:
 * the owner reads it and presses Schedule, or deletes it.
 *
 * The signature is appended at send time, so the body ends at the sign-off.
 */

export const FOLLOW_UP_AFTER_DAYS = 7;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function dayMonth(ms: number): string {
  const date = new Date(ms + 3 * 60 * 60 * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function followUpSubject(originalSubject: string): string {
  return /^re:/i.test(originalSubject.trim()) ? originalSubject.trim() : `Re: ${originalSubject.trim()}`;
}

export function followUpBody(input: { role?: string; sentAt: number }): string {
  const what = input.role !== undefined && input.role.trim() !== ""
    ? `the ${input.role.trim()} role`
    : "the role";
  return [
    "Hi,",
    "",
    `Following up on my email from ${dayMonth(input.sentAt)} about ${what}. I'm still interested, and happy to share more detail or jump on a short call if that helps.`,
    "",
    "Thanks,",
  ].join("\n");
}
