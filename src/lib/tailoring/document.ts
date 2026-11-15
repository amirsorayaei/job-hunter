/**
 * The tailored resume document schema.
 *
 * Spec: JOB-HUNTER-IMPLEMENTATION-PLAN-V3-CONVEX-CLOUD.md Phase 4,
 * deliverables 2 and 3.
 *
 * The central design decision: an LLM never writes resume prose freely. It
 * SELECTS and ORDERS approved fact ids, picks from approved aliases, and may
 * rewrite within tight bounds. Every rendered claim therefore traces to a fact
 * the candidate has confirmed, which is what makes the truthfulness rule
 * mechanically enforceable rather than a prompt instruction that a model may
 * quietly ignore.
 *
 * Versioned so a stored artifact can be reconstructed from the exact schema,
 * facts, and rules that produced it (Phase 4 criterion 4).
 */

import { z } from "zod";

export const TAILORED_DOCUMENT_VERSION = 1;

/** Hard caps from the PDF contract, enforced before rendering is attempted. */
export const LIMITS = {
  maxSkillLines: 7,
  maxBullets: 13,
  maxSummaryChars: 700,
  maxBulletChars: 260,
  maxSkillLineChars: 130,
  maxTitleChars: 60,
  maxLocationChars: 60,
} as const;

/**
 * One rendered claim.
 *
 * `factIds` is required and non-empty: a claim with no supporting fact cannot
 * be constructed, so the type system enforces provenance before any validator
 * runs.
 */
export const claimSchema = z.object({
  /** Rendered text. Must survive the truthfulness validator. */
  text: z.string().min(1).max(LIMITS.maxBulletChars),
  /** Approved facts this claim draws on. At least one. */
  factIds: z.array(z.string().min(1)).min(1),
});

export type Claim = z.infer<typeof claimSchema>;

export const experienceSchema = z.object({
  /** Employer name. Validated against the approved employer list. */
  employer: z.string().min(1),
  title: z.string().min(1).max(LIMITS.maxTitleChars),
  descriptor: z.string().max(60).optional(),
  location: z.string().max(LIMITS.maxLocationChars).optional(),
  /** Dates are copied verbatim from the master; never regenerated. */
  dates: z.string().min(1).max(40),
  mode: z.enum(["Remote", "On-Site", "Hybrid"]).optional(),
  bullets: z.array(claimSchema),
});

export const tailoredResumeSchema = z.object({
  schemaVersion: z.literal(TAILORED_DOCUMENT_VERSION),
  /** Header fields the model may choose between, never invent. */
  name: z.string().min(1),
  title: z.string().min(1).max(LIMITS.maxTitleChars),
  location: z.string().max(LIMITS.maxLocationChars),
  email: z.string().email(),
  links: z.array(z.object({ label: z.string(), url: z.string().url() })).max(4),

  summary: z.object({
    text: z.string().min(1).max(LIMITS.maxSummaryChars),
    factIds: z.array(z.string().min(1)).min(1),
  }),

  skills: z
    .array(
      z.object({
        category: z.string().min(1).max(40),
        items: z.string().min(1).max(LIMITS.maxSkillLineChars),
        factIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .max(LIMITS.maxSkillLines),

  experience: z.array(experienceSchema),

  education: z.object({
    degree: z.string().min(1),
    school: z.string().min(1),
    dates: z.string().min(1),
  }),

  languages: z.array(z.object({ name: z.string(), level: z.string() })).max(4),
});

export type TailoredResume = z.infer<typeof tailoredResumeSchema>;

/** Section order is fixed by the PDF contract and is not the model's choice. */
export const SECTION_ORDER = [
  "HEADER",
  "SUMMARY",
  "TECHNICAL SKILLS",
  "WORK EXPERIENCE",
  "EDUCATION",
  "LANGUAGES",
] as const;

/** Total bullets across all experience entries. */
export function countBullets(document: TailoredResume): number {
  return document.experience.reduce((sum, entry) => sum + entry.bullets.length, 0);
}

/** Every fact id the document claims to rest on. */
export function referencedFactIds(document: TailoredResume): string[] {
  const ids = new Set<string>(document.summary.factIds);
  for (const skill of document.skills) {
    for (const id of skill.factIds) ids.add(id);
  }
  for (const entry of document.experience) {
    for (const bullet of entry.bullets) {
      for (const id of bullet.factIds) ids.add(id);
    }
  }
  return [...ids].sort();
}
