/**
 * The approved catalogue, derived from the master resume.
 *
 * `~/Documents/Job Hunting/resume_content.py` remains the human source of
 * truth. This is a machine-readable projection of it and must never contain
 * anything that file does not.
 *
 * The employer-scoped technology map is the part that catches the subtle
 * fabrication: every technology here is genuinely the candidate's, but claiming
 * one at the wrong employer is still false.
 */

import type { ApprovedCatalogue } from "./validate";
import { FACTS, KNOWN_GAPS } from "../profile";

export const CATALOGUE_VERSION = 1;

export const IDENTITY = {
  name: "YOUR NAME",
  email: "you@example.com",
} as const;

/** Employer -> exact date string from the master. Never regenerated. */
const EMPLOYER_DATES: Record<string, string> = {
  "Levita Health": "Dec 2025 – Aug 2026",
  Roomvu: "Sep 2023 – Dec 2025",
  "A.P.P Software Solutions": "Sep 2020 – Sep 2023",
  Hoomaan: "Apr 2019 – Sep 2020",
};

/**
 * Technologies each employer's bullets may reference.
 *
 * Convex, Daily.co, and Stripe are Levita only. Claiming them at Roomvu would
 * be assembled entirely from approved facts and still be a lie — which is
 * precisely why binding is checked separately from the fact catalogue.
 */
const EMPLOYER_TECHNOLOGIES: Record<string, string[]> = {
  "Levita Health": [
    "next.js", "nextjs", "react", "typescript", "javascript", "tailwind",
    "radix", "shadcn", "convex", "stripe", "daily.co", "webrtc", "soniox",
    "postgresql", "zustand", "jotai", "tanstack", "react query", "figma",
    "i18n", "internationalization", "ssr", "server", "components", "vercel",
    "css", "css3", "html", "html5", "scss", "storybook", "playwright", "jest",
    "posthog", "openrouter", "websockets", "websocket", "auth", "oauth",
    "real-time", "realtime", "serverless",
  ],
  Roomvu: [
    "react", "javascript", "typescript", "next.js", "nextjs", "redux",
    "google", "css", "scss", "html", "jest", "cypress", "webpack", "seo",
    "oauth", "auth",
  ],
  "A.P.P Software Solutions": [
    "javascript", "react", "github", "git", "ci/cd", "docker", "webpack",
    "css", "html", "scss", "rest", "api",
  ],
  Hoomaan: [
    "javascript", "react", "css", "html", "scss", "jest", "e-commerce",
    "ecommerce", "responsive",
  ],
};

/**
 * Metrics that appear in the master resume.
 *
 * A model that "improves" 15% to 50% produces a sentence that still reads as
 * true, which makes this the highest-value check in the validator.
 */
const APPROVED_METRICS = [
  // resume-source/MASTER-RESUME-EVIDENCE.md, CONFIRMED/APPROXIMATE rows (2026-11).
  // Retired numbers (15%, 34%, 60%, 50%, 20%, 1M+) are deliberately absent.
  "10%", "40%", "30%", "400+", "500k+", "300", "400", "4m", "7+", "4+",
];

/** Seniority the history supports. "Staff" and "Principal" are absent. */
const APPROVED_SENIORITY = ["senior", "lead"];

/**
 * Fact-id prefixes describing the candidate or the sector rather than a tool
 * used at one employer. These are exempt from employer binding — "frontend"
 * and "payments" are not claims about which employer they were used at.
 */
const BINDING_EXEMPT_PREFIXES = ["role-", "seniority-", "experience-", "domain-"];

export function buildCatalogue(): ApprovedCatalogue {
  const facts = new Map<string, string[]>();
  const bindingExemptAliases = new Set<string>();

  for (const fact of FACTS) {
    const aliases = fact.aliases.map((alias) => alias.toLowerCase());
    facts.set(fact.id, aliases);

    if (BINDING_EXEMPT_PREFIXES.some((prefix) => fact.id.startsWith(prefix))) {
      for (const alias of aliases) bindingExemptAliases.add(alias);
    }
  }

  const employerTechnologies = new Map<string, Set<string>>();
  for (const [employer, technologies] of Object.entries(EMPLOYER_TECHNOLOGIES)) {
    employerTechnologies.set(
      employer,
      new Set(technologies.map((technology) => technology.toLowerCase())),
    );
  }

  return {
    facts,
    employers: new Set(Object.keys(EMPLOYER_DATES)),
    employerDates: new Map(Object.entries(EMPLOYER_DATES)),
    employerTechnologies,
    bindingExemptAliases,
    metrics: new Set(APPROVED_METRICS.map((metric) => metric.toLowerCase())),
    seniorityWords: new Set(APPROVED_SENIORITY),
    knownGaps: new Set(KNOWN_GAPS.map((gap) => gap.toLowerCase())),
    identity: { name: IDENTITY.name, email: IDENTITY.email },
  };
}
