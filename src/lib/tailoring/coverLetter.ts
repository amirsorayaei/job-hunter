/**
 * Cover letters, under the same provenance rules as the resume.
 *
 * Spec Phase 5 deliverable 7: "Cover-letter generation using the same
 * provenance rules."
 *
 * A cover letter is more dangerous than a resume, not less. Resume bullets are
 * terse and factual; a letter is prose, which is exactly the shape a language
 * model fills with enthusiastic invention — "I've long admired your work on X",
 * "I led a team of twelve". So the document is built the same way: paragraphs
 * are CLAIMS carrying approved fact ids, and the text goes through the same
 * catalogue-derived allowlist the resume does.
 *
 * The only structural difference is employer binding. A resume bullet sits
 * under one employer and may only mention that employer's technologies; a
 * letter paragraph names its employer inline, so binding is checked against
 * whichever approved employer the paragraph declares.
 */

import { z } from "zod";
import { claimSchema } from "./document";

export const COVER_LETTER_VERSION = 1;

export const COVER_LETTER_LIMITS = {
  maxParagraphs: 5,
  maxParagraphChars: 700,
  maxTotalChars: 2600,
  maxGreetingChars: 120,
  maxClosingChars: 160,
} as const;

/**
 * One paragraph.
 *
 * `employer` is optional and, when present, scopes the binding check: a
 * paragraph that says "At Roomvu I built …" may only reference technologies
 * Roomvu's work actually used.
 */
export const coverLetterParagraphSchema = claimSchema.extend({
  text: z.string().min(1).max(COVER_LETTER_LIMITS.maxParagraphChars),
  employer: z.string().min(1).optional(),
});

export const coverLetterSchema = z.object({
  schemaVersion: z.literal(COVER_LETTER_VERSION),
  name: z.string().min(1),
  email: z.string().email(),
  /**
   * The company being written to. Not a claim; masked before prose checks.
   * May be empty when the company is genuinely unknown — the composer then
   * writes an opening that names nobody rather than inventing a name.
   */
  company: z.string().max(80),
  /** The role being applied for, as the posting titles it. */
  roleTitle: z.string().min(1).max(80),
  greeting: z.string().min(1).max(COVER_LETTER_LIMITS.maxGreetingChars),
  paragraphs: z
    .array(coverLetterParagraphSchema)
    .min(1)
    .max(COVER_LETTER_LIMITS.maxParagraphs),
  closing: z.string().min(1).max(COVER_LETTER_LIMITS.maxClosingChars),
});

export type CoverLetter = z.infer<typeof coverLetterSchema>;
export type CoverLetterParagraph = z.infer<typeof coverLetterParagraphSchema>;

/** Every fact id the letter rests on. */
export function coverLetterFactIds(letter: CoverLetter): string[] {
  const ids = new Set<string>();
  for (const paragraph of letter.paragraphs) {
    for (const id of paragraph.factIds) ids.add(id);
  }
  return [...ids].sort();
}

/** The letter as plain text, ready to paste into a form or an email body. */
export function renderCoverLetterText(letter: CoverLetter): string {
  return [
    letter.greeting,
    "",
    ...letter.paragraphs.flatMap((paragraph) => [paragraph.text, ""]),
    letter.closing,
    letter.name,
    letter.email,
  ].join("\n");
}

export function coverLetterLength(letter: CoverLetter): number {
  return letter.paragraphs.reduce((sum, p) => sum + p.text.length, 0);
}
