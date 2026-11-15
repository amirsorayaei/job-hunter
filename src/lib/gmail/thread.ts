import { addressOf, classifyInbound } from "./classify";

/**
 * Reading one Gmail thread (format=metadata) for an application email.
 *
 * Pure, so the rules are unit-tested without Gmail: when did our first
 * message really leave (not a draft, not still scheduled), did a second one
 * (the follow-up) leave, and who else wrote after the first one.
 */

function headerValue(message: Record<string, unknown>, name: string): string | undefined {
  const payload = message.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined;
  const found = payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === name);
  return found?.value;
}

export const SYNC_HEADERS = ["From", "Subject", "Message-ID", "Auto-Submitted", "X-Autoreply", "X-Autorespond", "Precedence"];

export interface ThreadReading {
  missing: boolean;
  scheduled: boolean;
  /** When a scheduled message will leave (its internalDate). */
  scheduledFor?: number;
  sent?: { at: number; rfcMessageId?: string };
  followUpSentAt?: number;
  replies: Array<{ from: string; snippet: string; at: number; kind: "reply" | "auto_reply" | "bounce" }>;
}

/** Read one thread: when did our messages leave, and who answered after. */
export function readThread(messages: Array<Record<string, unknown>>, me: string): Omit<ThreadReading, "missing"> {
  const ordered = [...messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  let scheduled = false;
  let scheduledFor: number | undefined;
  let sent: ThreadReading["sent"];
  let followUpSentAt: number | undefined;
  const replies: ThreadReading["replies"] = [];

  for (const message of ordered) {
    const at = Number(message.internalDate);
    if (!Number.isFinite(at)) continue;
    const labels = Array.isArray(message.labelIds) ? (message.labelIds as string[]) : [];
    const from = headerValue(message, "from") ?? "";
    if (addressOf(from) === me) {
      if (labels.includes("DRAFT")) continue;
      // Gmail's API shows a scheduled message with no labels at all (or, on
      // some accounts, SCHEDULED) and dates it at the time it will be sent.
      if (labels.includes("SCHEDULED") || !labels.includes("SENT")) {
        scheduled = true;
        scheduledFor = at;
        continue;
      }
      if (sent === undefined) sent = { at, rfcMessageId: headerValue(message, "message-id") };
      else if (followUpSentAt === undefined) followUpSentAt = at;
      continue;
    }
    if (sent === undefined || at <= sent.at) continue;
    const headers: Record<string, string> = {};
    for (const name of SYNC_HEADERS) {
      const value = headerValue(message, name.toLowerCase());
      if (value !== undefined) headers[name.toLowerCase()] = value;
    }
    replies.push({
      from,
      snippet: typeof message.snippet === "string" ? message.snippet : "",
      at,
      kind: classifyInbound({ from, subject: headerValue(message, "subject"), headers }),
    });
  }
  return { scheduled, scheduledFor, sent, followUpSentAt, replies };
}

