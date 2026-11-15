import { describe, expect, it } from "vitest";
import { emailsIn, isFresh, isRelevantTitle, placementOf, trackFor } from "../../src/lib/agent/filter";

describe("title filter", () => {
  it("keeps developer titles Candidate can hold", () => {
    for (const title of [
      "Senior Frontend Engineer",
      "Full-Stack Developer (React/Node)",
      "Software Engineer, Product",
      "Founding Engineer",
      "Senior React Developer",
      "Product Engineer - Growth",
      "Backend Engineer (Node.js)",
    ]) {
      expect(isRelevantTitle(title), title).toBe(true);
    }
  });

  it("drops what is not for him", () => {
    for (const title of [
      "Engineering Manager, Frontend",
      "Senior iOS Engineer",
      "Data Engineer",
      "QA Automation Engineer",
      "Java Software Engineer",
      "Senior Backend Engineer (Go)",
      "Product Designer",
      "Frontend Intern",
      "Account Executive",
      "Angular Frontend Developer",
      "React Native Engineer",
      "Platform Engineer II - Observability",
      "Data & Platform Engineer",
      "Principal Software Engineer",
      "Software Engineer Infrastructure",
    ]) {
      expect(isRelevantTitle(title), title).toBe(false);
    }
  });

  it("does not mistake JavaScript for Java", () => {
    expect(isRelevantTitle("JavaScript Engineer")).toBe(true);
  });
});

describe("track", () => {
  it("sends clear frontend titles to the frontend agent and the rest to full-stack", () => {
    expect(trackFor("Senior Frontend Engineer")).toBe("frontend");
    expect(trackFor("React Developer")).toBe("frontend");
    expect(trackFor("Full Stack Engineer (React)")).toBe("fullstack");
    expect(trackFor("Software Engineer")).toBe("fullstack");
    expect(trackFor("Founding Engineer")).toBe("fullstack");
  });
});

describe("placement", () => {
  const base = { title: "Frontend Engineer", description: "" };
  it("accepts remote, Turkey and visa-sponsored roles", () => {
    expect(placementOf({ ...base, location: "Remote - US", workplaceType: "unknown" })).toBe("remote");
    expect(placementOf({ ...base, location: "Berlin", workplaceType: "remote" })).toBe("remote");
    expect(placementOf({ ...base, location: "Istanbul, Türkiye" })).toBe("turkey");
    expect(
      placementOf({ ...base, location: "Amsterdam", description: "We offer visa sponsorship and a relocation package." }),
    ).toBe("visa");
  });

  it("rejects on-site roles with no visa help", () => {
    expect(placementOf({ ...base, location: "London, UK", workplaceType: "onsite" })).toBeNull();
    expect(placementOf({ ...base, location: "Munich", description: "Hybrid, 3 days in the office." })).toBeNull();
  });
});

describe("freshness and emails", () => {
  const now = Date.UTC(2026, 10, 10);
  it("ignores postings older than 45 days only when a date is known", () => {
    expect(isFresh("2026-11-01", now)).toBe(true);
    expect(isFresh("2026-08-01", now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(true);
    expect(isFresh("not a date", now)).toBe(true);
  });

  it("finds hiring addresses and skips system ones", () => {
    expect(
      emailsIn("Send your CV to Jobs@Acme.io. Questions: privacy@acme.io, noreply@acme.io, logo@2x.png"),
    ).toEqual(["jobs@acme.io"]);
  });
});
