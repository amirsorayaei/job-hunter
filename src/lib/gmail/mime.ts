/**
 * RFC 5322 / MIME message for the Gmail `messages.send` endpoint.
 *
 * Plain text only, UTF-8, base64 transfer encoding for the body so non-ASCII
 * names survive, and at most one attachment (the tailored resume PDF).
 * Header values are checked for CR/LF so a subject or address can never inject
 * an extra header.
 */

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Message-ID of the email being replied to, for threading. */
  inReplyTo?: string;
  attachment?: { filename: string; mimeType: string; data: Uint8Array };
  /** Injected for deterministic tests. */
  boundary?: string;
}

function assertHeaderSafe(label: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${label} contains a line break`);
}

function base64(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64");
}

/** Wrap base64 at 76 columns, as MIME requires. */
function wrap(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** RFC 2047 encoded-word when the subject is not plain ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${base64(value)}?=`;
}

export function buildMime(input: MimeInput): string {
  assertHeaderSafe("From", input.from);
  assertHeaderSafe("To", input.to);
  assertHeaderSafe("Subject", input.subject);
  if (input.inReplyTo !== undefined) assertHeaderSafe("In-Reply-To", input.inReplyTo);
  if (input.attachment !== undefined) {
    assertHeaderSafe("Attachment name", input.attachment.filename);
    if (/["\\]/.test(input.attachment.filename)) {
      throw new Error("Attachment name contains a quote or backslash");
    }
  }

  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (input.inReplyTo !== undefined) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(input.body.replace(/\r?\n/g, "\r\n"))),
  ].join("\r\n");

  if (input.attachment === undefined) {
    return [...headers, textPart].join("\r\n");
  }

  const boundary = input.boundary ?? `jh_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const attachmentPart = [
    `Content-Type: ${input.attachment.mimeType}; name="${input.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(input.attachment.data)),
  ].join("\r\n");

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    textPart,
    `--${boundary}`,
    attachmentPart,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Gmail wants the raw message as base64url. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
