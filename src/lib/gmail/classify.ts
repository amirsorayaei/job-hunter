/**
 * What kind of message arrived on a tracked thread.
 *
 * Deliberately rule-based: a bounce and an out-of-office are recognisable from
 * headers, and everything else from a person counts as a reply. Telling an
 * interview invite from a rejection is left to the owner (and later to the
 * local AI pass); guessing it here would move applications on a hunch.
 */

export type InboundClass = "reply" | "auto_reply" | "bounce";

export interface InboundHeaders {
  from: string;
  subject?: string;
  /** Lower-cased header name to value. */
  headers: Record<string, string>;
}

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const BOUNCE_SUBJECT =
  /delivery status notification|undeliverable|undelivered mail|delivery (has )?failed|failure notice|returned mail|address not found/i;
const AUTO_SUBJECT =
  /^\s*(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|ooo\b|away from)/i;

export function classifyInbound(message: InboundHeaders): InboundClass {
  const subject = message.subject ?? "";

  if (BOUNCE_SENDER.test(message.from) || BOUNCE_SUBJECT.test(subject)) return "bounce";

  const autoSubmitted = message.headers["auto-submitted"];
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") {
    return "auto_reply";
  }
  if (message.headers["x-autoreply"] !== undefined) return "auto_reply";
  if (message.headers["x-autorespond"] !== undefined) return "auto_reply";
  if (/auto_reply/i.test(message.headers["precedence"] ?? "")) return "auto_reply";
  if (AUTO_SUBJECT.test(subject)) return "auto_reply";

  return "reply";
}

/** The bare address from a `From:` value like `Jane <jane@acme.com>`. */
export function addressOf(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim().toLowerCase();
}

/** Loose but adequate check before an address is stored as a recipient. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(value.trim());
}
