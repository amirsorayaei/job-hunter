import { describe, expect, it } from "vitest";
import { eligibilityLines, emailsIn, isFresh, isIndiaRole, isRelevantTitle, placementOf, textForScoring, titleKey, trackFor } from "../../src/lib/agent/filter";

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

  it("follows the title: Frontend in the title is Frontend, Full Stack is Full-Stack", () => {
    for (const title of [
      "Software Engineer- Frontend",
      "Senior Frontend React Engineer (Product & Design Collaboration)",
      "Front End Engineer",
      "Front-end Developer",
      "Senior Software Engineer, Frontend",
      "Full Stack Engineer (Frontend focus)",
    ]) {
      expect(trackFor(title), title).toBe("frontend");
    }
    for (const title of ["Full Stack Engineer (TypeScript/React/Node)", "Senior Full-Stack Engineer", "Fullstack Engineer", "Senior Software Engineer, Full Stack"]) {
      expect(trackFor(title), title).toBe("fullstack");
    }
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

  it("drops India roles everywhere, even remote ones", () => {
    expect(placementOf({ ...base, location: "Remote - India", workplaceType: "remote" })).toBeNull();
    expect(placementOf({ ...base, location: "Bengaluru, Karnataka" })).toBeNull();
    expect(placementOf({ ...base, location: "Remote", description: "This role is open only to candidates based in India." })).toBeNull();
    expect(isIndiaRole({ company: "CSC Generation (Shared Services – India, Engineering)", title: "Senior Frontend Engineer" })).toBe(true);
    expect(isIndiaRole({ remoteWording: "Open only to candidates in India" })).toBe(true);
  });

  it("keeps roles that only mention India in passing", () => {
    expect(isIndiaRole({ location: "Remote", title: "Frontend Engineer", description: "We have offices in London and Pune." })).toBe(false);
    expect(isIndiaRole({ location: "Remote - EU", title: "Frontend Engineer", company: "Acme" })).toBe(false);
    expect(placementOf({ ...base, location: "Remote - US", workplaceType: "remote" })).toBe("remote");
  });
});

describe("eligibility lines", () => {
  const filler = "We build great software with React and TypeScript. ".repeat(80);
  it("pulls a citizenship gate from the end of a long posting into what the scorer reads", () => {
    const text = `${filler} Due to federal government contract requirements, eligible candidates must hold United States citizenship.`;
    const scored = textForScoring(text);
    expect(scored).toContain("[Eligibility lines from the full posting]");
    expect(scored).toContain("must hold United States citizenship");
  });

  it("finds residence and authorization lines", () => {
    const lines = eligibilityLines(
      "Great team. Please note, you must reside in the country for which you are applying. You must legally be able to work in the country. We offer snacks.",
    );
    expect(lines).toHaveLength(2);
  });

  it("adds nothing when the opening already holds the line or there is none", () => {
    expect(textForScoring("Remote role. We sponsor visas. React work.")).toBe("Remote role. We sponsor visas. React work.");
    expect(textForScoring(filler)).toBe(filler.slice(0, 3500));
  });
});

describe("one row per job, not per country", () => {
  const grafana = (place: string) => titleKey("Grafana Labs", `Senior Full Stack Engineer | Experimentation - Product Analytics | ${place} | Remote`);
  it("gives the same key to the per-country copies", () => {
    expect(new Set(["UK", "Sweden", "Spain", "Ireland", "Germany", "NASA"].map(grafana)).size).toBe(1);
    expect(titleKey("Acme", "Frontend Engineer (Remote, US)")).toBe(titleKey("Acme", "Frontend Engineer (Canada)"));
  });

  it("keeps genuinely different roles apart", () => {
    expect(titleKey("Acme", "Senior Engineer | AI")).not.toBe(titleKey("Acme", "Senior Engineer | Payments"));
    expect(titleKey("Acme", "Frontend Engineer")).not.toBe(titleKey("Acme", "Full Stack Engineer"));
    expect(titleKey("Acme", "Frontend Engineer")).not.toBe(titleKey("Other", "Frontend Engineer"));
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
