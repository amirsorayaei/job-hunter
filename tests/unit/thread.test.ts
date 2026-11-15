import { describe, expect, it } from "vitest";
import { readThread } from "../../src/lib/gmail/thread";

const ME = "you@example.com";

function message(input: {
  at: number;
  from: string;
  labels: string[];
  subject?: string;
  messageId?: string;
  snippet?: string;
  headers?: Record<string, string>;
}) {
  const headers = [
    { name: "From", value: input.from },
    { name: "Subject", value: input.subject ?? "Application" },
    ...(input.messageId !== undefined ? [{ name: "Message-ID", value: input.messageId }] : []),
    ...Object.entries(input.headers ?? {}).map(([name, value]) => ({ name, value })),
  ];
  return {
    id: `m${input.at}`,
    internalDate: String(input.at),
    labelIds: input.labels,
    snippet: input.snippet ?? "",
    payload: { headers },
  };
}

describe("reading an application thread", () => {
  it("treats a draft as not sent", () => {
    const reading = readThread([message({ at: 1, from: `Candidate <${ME}>`, labels: ["DRAFT"] })], ME);
    expect(reading.sent).toBeUndefined();
    expect(reading.scheduled).toBe(false);
  });

  it("notices a message waiting in Scheduled", () => {
    const reading = readThread([message({ at: 1, from: ME, labels: ["SCHEDULED"] })], ME);
    expect(reading.scheduled).toBe(true);
    expect(reading.sent).toBeUndefined();
  });

  it("treats our message with no labels as scheduled (what the Gmail API really returns)", () => {
    const sendAt = Date.UTC(2026, 10, 11, 4, 30);
    const reading = readThread([message({ at: sendAt, from: `Candidate <${ME}>`, labels: [] })], ME);
    expect(reading.scheduled).toBe(true);
    expect(reading.scheduledFor).toBe(sendAt);
    expect(reading.sent).toBeUndefined();
  });

  it("records the send time and Message-ID of the first sent message", () => {
    const reading = readThread(
      [message({ at: 1000, from: `Candidate <${ME}>`, labels: ["SENT"], messageId: "<abc@mail.gmail.com>" })],
      ME,
    );
    expect(reading.sent).toEqual({ at: 1000, rfcMessageId: "<abc@mail.gmail.com>" });
  });

  it("treats our second sent message as the follow-up", () => {
    const reading = readThread(
      [
        message({ at: 2000, from: ME, labels: ["SENT"] }),
        message({ at: 1000, from: ME, labels: ["SENT"] }),
      ],
      ME,
    );
    expect(reading.sent?.at).toBe(1000);
    expect(reading.followUpSentAt).toBe(2000);
  });

  it("classifies what others wrote after the send", () => {
    const reading = readThread(
      [
        message({ at: 1000, from: ME, labels: ["SENT"] }),
        message({ at: 1500, from: "Jane <jane@acme.com>", labels: ["INBOX"], snippet: "Thanks, can we talk?" }),
        message({ at: 1600, from: "x@acme.com", labels: ["INBOX"], subject: "Out of office" }),
        message({ at: 1700, from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", labels: ["INBOX"] }),
      ],
      ME,
    );
    expect(reading.replies.map((reply) => reply.kind)).toEqual(["reply", "auto_reply", "bounce"]);
    expect(reading.replies[0].snippet).toBe("Thanks, can we talk?");
  });

  it("ignores anything from others before our email left", () => {
    const reading = readThread([message({ at: 500, from: "jane@acme.com", labels: ["INBOX"] })], ME);
    expect(reading.replies).toEqual([]);
  });
});
