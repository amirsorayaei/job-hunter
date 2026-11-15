import { describe, expect, it } from "vitest";
import { addressOf, classifyInbound, isEmailAddress } from "../../src/lib/gmail/classify";
import { buildMime, encodeHeaderValue, toBase64Url } from "../../src/lib/gmail/mime";
import { followUpBody, followUpSubject } from "../../src/lib/gmail/followUp";
import { buildCatalogue } from "../../src/lib/tailoring/catalogue";
import { validateOutreachText } from "../../src/lib/tailoring/validate";

import { istanbulDate, istanbulDayStart } from "../../src/lib/time";

describe("Istanbul calendar", () => {
  it("starts the day at 00:00 UTC+3", () => {
    expect(istanbulDayStart(Date.UTC(2026, 10, 9, 12, 0))).toBe(Date.UTC(2026, 10, 8, 21, 0));
    // 23:30 UTC on the 9th is already the 10th in Istanbul.
    expect(istanbulDate(Date.UTC(2026, 10, 9, 23, 30))).toBe("2026-11-10");
  });
});

describe("inbound classification", () => {
  it("recognises bounces", () => {
    expect(classifyInbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", headers: {} })).toBe("bounce");
    expect(classifyInbound({ from: "x@y.com", subject: "Delivery Status Notification (Failure)", headers: {} })).toBe("bounce");
  });

  it("recognises automatic replies", () => {
    expect(classifyInbound({ from: "a@b.com", headers: { "auto-submitted": "auto-replied" } })).toBe("auto_reply");
    expect(classifyInbound({ from: "a@b.com", subject: "Out of Office: back Monday", headers: {} })).toBe("auto_reply");
    expect(classifyInbound({ from: "a@b.com", headers: { "auto-submitted": "no" } })).toBe("reply");
  });

  it("treats a person as a reply", () => {
    expect(classifyInbound({ from: "Jane <jane@acme.com>", subject: "Re: Frontend role", headers: {} })).toBe("reply");
  });

  it("parses addresses", () => {
    expect(addressOf("Jane Doe <Jane@Acme.com>")).toBe("jane@acme.com");
    expect(isEmailAddress("hiring@acme.io")).toBe(true);
    expect(isEmailAddress("not an email")).toBe(false);
    expect(isEmailAddress("a@b.com, c@d.com")).toBe(false);
  });
});

describe("MIME", () => {
  it("refuses header injection", () => {
    expect(() =>
      buildMime({ from: "me@x.com", to: "a@b.com\r\nBcc: evil@x.com", subject: "Hi", body: "x" }),
    ).toThrow(/line break/);
    expect(() => buildMime({ from: "me@x.com", to: "a@b.com", subject: "Hi\nBcc: e@x.com", body: "x" })).toThrow();
  });

  it("encodes non-ASCII subjects and bodies", () => {
    expect(encodeHeaderValue("Hello")).toBe("Hello");
    expect(encodeHeaderValue("Türkiye")).toMatch(/^=\?UTF-8\?B\?/);
    const raw = buildMime({ from: "me@x.com", to: "a@b.com", subject: "Türkiye", body: "Merhaba ş" });
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    const encodedBody = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(encodedBody, "base64").toString("utf8")).toBe("Merhaba ş");
  });

  it("attaches a PDF and threads a reply", () => {
    const raw = buildMime({
      from: "me@x.com",
      to: "a@b.com",
      subject: "Re: Role",
      body: "Following up",
      inReplyTo: "<abc@mail.gmail.com>",
      attachment: { filename: "YourName-Resume-Acme.pdf", mimeType: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) },
      boundary: "BOUNDARY",
    });
    expect(raw).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    expect(raw).toContain('filename="YourName-Resume-Acme.pdf"');
    expect(raw.trimEnd().endsWith("--BOUNDARY--")).toBe(true);
    expect(toBase64Url(raw)).not.toMatch(/[+/=]/);
  });
});

describe("follow-up draft", () => {
  it("is short, threaded, free of em-dashes, and passes the truthfulness check", () => {
    const body = followUpBody({ role: "Senior Frontend Engineer", sentAt: Date.UTC(2026, 10, 10, 7, 0) });
    expect(body).toContain("November 10");
    expect(body).not.toMatch(/[—–]/);
    expect(followUpSubject("Frontend role")).toBe("Re: Frontend role");
    expect(followUpSubject("Re: Frontend role")).toBe("Re: Frontend role");

    const result = validateOutreachText(
      { subject: followUpSubject("Frontend role"), body, factIds: [] },
      buildCatalogue(),
      ["Senior Frontend Engineer", "Frontend role"],
    );
    expect(result.violations).toEqual([]);
  });
});

describe("friendlyError", () => {
  it("extracts the thrown message from a Convex server error", async () => {
    const { friendlyError } = await import("../../src/lib/convexError");
    const raw = new Error(
      "[CONVEX M(gmail/mutations:scheduleDraft)] [Request ID: 5d83] Server Error\nUncaught Error: No resume PDF for this application yet. Tailor one first\n    at handler (../../convex/gmail/mutations.ts:342:36)",
    );
    expect(friendlyError(raw, "x")).toBe("No resume PDF for this application yet. Tailor one first");
    expect(friendlyError("nope", "fallback")).toBe("fallback");
  });
});
