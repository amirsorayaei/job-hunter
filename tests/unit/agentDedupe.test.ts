import { describe, expect, it } from "vitest";
import { classify, normUrl } from "../../src/lib/agentDedupe";

const seen = [
  { company: "ElevenLabs", role: "Full-Stack Engineer" },
  { company: "Poolday (via A-Players)", role: "Senior Agentic Software Engineer", url: "https://aplayers.na.teamtailor.com/jobs/536324-x" },
  { company: "Acme", role: "Backend Engineer", url: "https://job-boards.greenhouse.io/acme/jobs/42" },
];

describe("agent dedupe", () => {
  it("mirrors history.py URL normalization", () => {
    expect(normUrl("https://www.Example.com/jobs/1/apply?utm=x")).toBe("example.com/jobs/1");
    expect(normUrl("https://boards.greenhouse.io/acme/jobs/42")).toBe("greenhouse/42");
    expect(normUrl("https://acme.com/careers?gh_jid=42")).toBe("greenhouse/42");
  });

  it("drops the same requisition, even on another Greenhouse host", () => {
    expect(classify({ company: "Acme", title: "x", url: "https://acme.com/careers?gh_jid=42" }, seen)).toBe("duplicate");
    expect(classify({ company: "Poolday", title: "Senior Agentic Software Engineer | Poolday", url: "https://aplayers.na.teamtailor.com/jobs/536324-x" }, seen)).toBe("duplicate");
  });

  it("drops variants of a role already seen at the same company", () => {
    for (const title of ["Full-Stack Engineer - ElevenAPI", "Full-Stack Engineer (Frontend Leaning) - Studio", "Full-Stack Engineer"]) {
      expect(classify({ company: "ElevenLabs", title, url: `https://jobs.ashbyhq.com/elevenlabs/${title.length}` }, seen), title).toBe("duplicate");
    }
  });

  it("keeps a genuinely different role and flags the company", () => {
    expect(classify({ company: "Acme", title: "Senior Frontend Engineer", url: "https://jobs.lever.co/acme/1" }, seen)).toBe("known_company");
    expect(classify({ company: "NewCo", title: "Product Engineer", url: "https://jobs.lever.co/newco/1" }, seen)).toBe("new");
  });
});
