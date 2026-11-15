import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 5 criterion 3: "No outreach is sent."
 *
  * The structural guarantee: the guarantee is not that the send path is disabled, it is
 * that there is no send path. A reviewer should be able to establish that by
 * reading the code, and this test asserts what that reading would find.
 *
 * The scan is deliberately crude — a message transport is not subtle. It looks
 * for outbound calls and for the SDKs that would carry one.
 */

const CONVEX_DIR = join(import.meta.dirname, "../../convex");

const OUTREACH_MODULES = ["roles.ts", "postings.ts", "companies.ts", "settings.ts", "runs.ts", "http.ts"];

/** Anything that could put a message on the wire. */
const TRANSPORT_PATTERNS: Array<[string, RegExp]> = [
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["nodemailer", /\bnodemailer\b/],
  ["sendgrid", /sendgrid/i],
  ["resend", /["']resend["']|\bResend\b/],
  ["postmark", /postmark/i],
  ["mailgun", /mailgun/i],
  ["smtp", /\bsmtp\b/i],
  ["twilio", /twilio/i],
  ["mailto link", /mailto:/],
  ["linkedin api", /api\.linkedin\.com/],
];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Gmail (owner's request, 2026-11-10) is the one sanctioned transport. These
 * tests pin where it lives and where it can reach: only convex/gmail/node.ts
 * makes network calls, only to Google, and the scheduling and query modules
 * stay as transport-free as the outreach modules above.
 */
describe("the Gmail transport is confined", () => {
  const GMAIL_DIR = join(CONVEX_DIR, "gmail");

  it("keeps scheduling and queries free of network calls", () => {
    for (const file of ["mutations.ts", "queries.ts"]) {
      const source = readFileSync(join(GMAIL_DIR, file), "utf8");
      for (const [label, pattern] of TRANSPORT_PATTERNS) {
        expect(pattern.test(source), `gmail/${file} contains ${label}`).toBe(false);
      }
    }
  });

  it("reaches only Google from the sending module", () => {
    const source = readFileSync(join(GMAIL_DIR, "node.ts"), "utf8");
    const hosts = [...source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(["oauth2.googleapis.com", "gmail.googleapis.com"], host).toContain(host);
    }
  });

  it("only ever creates drafts: there is no send call", () => {
    const source = readFileSync(join(GMAIL_DIR, "node.ts"), "utf8");
    expect(source).toContain("/drafts");
    expect(/messages\/send|drafts\/send/.test(source)).toBe(false);
  });

  it("is the only Convex module that knows the Gmail API", () => {
    for (const file of walk(CONVEX_DIR)) {
      if (file === join(GMAIL_DIR, "node.ts")) continue;
      const source = readFileSync(file, "utf8");
      expect(/gmail\.googleapis\.com/.test(source), file).toBe(false);
    }
  });
});

describe("no outreach transport exists (criterion 3)", () => {
  it("has no transport in any module that touches outreach", () => {
    for (const relative of OUTREACH_MODULES) {
      const source = readFileSync(join(CONVEX_DIR, relative), "utf8");
      for (const [label, pattern] of TRANSPORT_PATTERNS) {
        expect(pattern.test(source), `${relative} contains ${label}`).toBe(false);
      }
    }
  });

  it("exports no function whose name suggests sending", () => {
    // `recordSentByUser` is the one near-miss, and it is deliberate: the user
    // is the sender. The pattern below requires `send` to START an exported
    // name, which that does not.
    for (const file of walk(CONVEX_DIR)) {
      const source = readFileSync(file, "utf8");
      const exports = [...source.matchAll(/export const (\w+)\s*=/g)].map((m) => m[1]);
      for (const name of exports) {
        expect(/^(send|deliver|transmit|email|dispatch)/i.test(name), `${file}: ${name}`).toBe(
          false,
        );
      }
    }
  });

  it("keeps the whole Convex surface free of email SDK imports", () => {
    for (const file of walk(CONVEX_DIR)) {
      const source = readFileSync(file, "utf8");
      expect(/from ["'](nodemailer|resend|@sendgrid|postmark|mailgun)/.test(source), file).toBe(
        false,
      );
    }
  });
});
