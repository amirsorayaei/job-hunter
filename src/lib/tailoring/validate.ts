/**
 * Truthfulness validation.
 *
 * Spec: Phase 4 deliverable 4 and acceptance criterion 2 — "Block unsupported
 * technology, number, employer, responsibility, date, seniority, and
 * employer/project binding" and "Unsupported claims block the run and produce
 * no ready artifact".
 *
 * This is the most safety-critical module in the project. Everything else can
 * fail loudly and be retried; a fabricated claim gets sent to an employer under
 * the candidate's name and cannot be recalled.
 *
 * The design principle is that the validator does not trust the generator at
 * all. It re-derives what the document is ALLOWED to say from the approved
 * catalogue, then checks what it DOES say against that — an allowlist, never a
 * blocklist. A blocklist can only catch fabrications somebody predicted.
 *
 * Pure and deterministic. No model calls, no I/O.
 */

import {
  countBullets,
  LIMITS,
  referencedFactIds,
  type TailoredResume,
} from "./document";
import {
  COVER_LETTER_LIMITS,
  coverLetterFactIds,
  coverLetterLength,
  type CoverLetter,
} from "./coverLetter";

export const VALIDATOR_RULE_VERSION = 1;

export type ViolationKind =
  | "unknown_fact_id"
  | "unsupported_technology"
  | "unsupported_metric"
  | "unknown_employer"
  | "employer_binding"
  | "altered_dates"
  | "seniority_inflation"
  | "identity_mismatch"
  | "limit_exceeded";

export interface Violation {
  kind: ViolationKind;
  where: string;
  detail: string;
  /** The offending text, quoted for the review UI. */
  offending?: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  ruleVersion: number;
}

/** The approved ground truth a document is checked against. */
export interface ApprovedCatalogue {
  /** Fact id -> the aliases that fact licenses. */
  facts: Map<string, string[]>;
  /** Employers the candidate has actually worked for. */
  employers: Set<string>;
  /** Employer -> the exact date string from the master resume. */
  employerDates: Map<string, string>;
  /** Employer -> the technologies that employer's work may reference. */
  employerTechnologies: Map<string, Set<string>>;
  /**
   * Aliases exempt from employer binding.
   *
   * Role, seniority, and domain words ("frontend", "senior", "payments")
   * describe the candidate or the sector, not a tool used at one employer.
   * Without this exemption the binding check fires on ordinary prose — "Built
   * the frontend" was reported as a violation at every employer.
   */
  bindingExemptAliases: Set<string>;
  /** Every metric that appears in the master, normalized (e.g. "15%", "1m+"). */
  metrics: Set<string>;
  /** Seniority words the candidate's history supports. */
  seniorityWords: Set<string>;
  /** Fixed identity fields. */
  identity: { name: string; email: string };
  /**
   * Technologies the candidate has explicitly confirmed he does NOT have.
   *
   * Always flagged, whatever their position or capitalization. Without this a
   * skills line consisting of the single word "Kubernetes" evaded detection:
   * it sits at offset 0, so the sentence-start rule suppressed the
   * capitalized-proper-noun heuristic. Known gaps are never heuristic.
   */
  knownGaps: Set<string>;
}

/**
 * Technology-shaped tokens found in text.
 *
 * Deliberately broad: it is better to extract a non-technology and find it in
 * the catalogue than to miss a fabricated one. Includes dotted and plus forms
 * (`Next.js`, `C++`) and hyphenated names.
 */
// Slash included so "CI/CD" stays one token; splitting it produced a phantom
// "CD" that matched no fact.
const TECH_TOKEN = /\b[A-Za-z][A-Za-z0-9]*(?:[.+#/-][A-Za-z0-9+#]+)*\b/g;

/**
 * Numbers that make a factual claim: percentages, multipliers, counts.
 *
 * No trailing `\b`. With one, `85%` failed to match as a unit — `%` is a
 * non-word character, so there is no boundary after it — and the regex
 * backtracked to the bare number `85`, which the small-integer rule then
 * discarded as prose. Inflated percentages passed validation silently.
 */
// k/m only as a unit: "15 minutes" is not "15m".
const METRIC_TOKEN = /\b\d(?:[\d,.]*\d)?\s*(?:%|percent|x\b|\+|k\+?(?![a-z])|m\+?(?![a-z])|million|billion)?/gi;

/** Words that assert a seniority level. */
const SENIORITY_WORDS = [
  "junior", "mid", "senior", "staff", "principal", "lead", "head",
  "director", "vp", "chief", "architect", "manager",
];

/**
 * Words common enough in prose that requiring catalogue support would produce
 * only noise. None of them names a technology, an employer, or a metric.
 */
const PROSE_ALLOWLIST = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "into", "across", "over", "under", "through", "that", "which", "who",
  "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "these", "those", "or", "but", "not", "no", "all", "every", "each", "both",
  "built", "build", "building", "builds", "led", "lead", "leading", "leads",
  "shipped", "ship", "shipping", "ships", "delivered", "deliver", "delivering",
  "designed", "design", "designing", "owns", "own", "owning", "owned",
  "improved", "improve", "improving", "cut", "cutting", "reduced", "reduce",
  "increased", "increase", "raising", "raised", "engineered", "engineer",
  "implemented", "implement", "integrated", "integrate", "migrated", "migrate",
  "refactored", "refactor", "optimized", "optimize", "optimizing",
  "maintained", "maintain", "created", "create", "developed", "develop",
  "worked", "work", "working", "collaborating", "collaborated", "collaborate",
  "years", "year", "experience", "production", "platform", "platforms",
  "application", "applications", "app", "apps", "site", "sites", "page",
  "pages", "team", "teams", "product", "products", "user", "users", "customer",
  "customers", "feature", "features", "system", "systems", "service",
  "services", "code", "codebase", "codebases", "project", "projects",
  "engineer", "engineering", "developer", "development", "software", "web",
  "frontend", "front", "end", "fullstack", "full", "stack", "backend",
  "interface", "interfaces", "ui", "ux", "component", "components", "library",
  "libraries", "architecture", "quality", "testing", "tests", "test",
  "deployment", "deploy", "pipeline", "pipelines", "time", "times", "speed",
  "load", "loads", "performance", "scale", "scalable", "consistent",
  "consistency", "responsive", "accessible", "reusable", "shared", "common",
  "modern", "clean", "complex", "critical", "core", "key", "main", "primary",
  "new", "first", "second", "third", "fourth", "one", "two", "three", "four",
  "five", "six", "seven", "eight", "nine", "ten", "plus", "more", "most",
  "than", "per", "between", "while", "when", "where", "how", "what", "why",
  "including", "include", "includes", "such", "e", "g", "etc", "via", "using",
  "use", "used", "uses", "before", "after", "during", "since", "until",
  "own", "self", "end-to-end", "cross-functional", "day-to-day", "hands-on",
  "senior", "remote", "on-site", "hybrid", "present", "current", "currently",
  "spain", "canada", "iran", "netherlands", "germany", "barcelona",
  "vancouver", "mashhad", "amsterdam", "madrid", "berlin", "worldwide",
  // Places that come up in relocation and sponsorship conversations. These are
  // facts about where the candidate is and may go, not technology claims.
  "turkey", "istanbul", "ankara", "portugal", "lisbon", "poland", "munich",
  "london", "paris", "dublin", "europe", "eu", "relocation", "sponsorship",
  "visa", "timezone", "cet", "cest", "utc",
  // Correspondence vocabulary. Added after a draft reading "Thanks — Tuesday
  // works." was blocked: "Tuesday" is a capitalized proper noun, so the
  // technology heuristic fired on scheduling an interview. Days, months, and
  // salutations name nothing technical and never carry a capability claim.
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "hi", "hello", "thanks", "thank", "you", "regards", "best", "kind", "yours",
  "sincerely", "dear", "team", "role", "position", "opportunity", "posting",
  "application", "interview", "call", "schedule", "scheduling", "availability",
  "available", "open", "英", "b", "c",
]);

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[.,;:]+$/, "");
}

/** Normalize a metric for comparison: "1M+" and "1m+" are the same claim. */
function normalizeMetric(token: string): string {
  return token.toLowerCase().replace(/[\s,]/g, "");
}

/**
 * Validate a tailored document against the approved catalogue.
 *
 * Returns every violation rather than stopping at the first, so the review UI
 * can show the full picture instead of one problem at a time.
 */
export function validateTailoredDocument(
  document: TailoredResume,
  catalogue: ApprovedCatalogue,
): ValidationResult {
  const violations: Violation[] = [];

  // ── Identity ─────────────────────────────────────────────────────────────
  // Name and email are never the model's to choose. A changed email silently
  // sends replies somewhere else.
  if (document.name !== catalogue.identity.name) {
    violations.push({
      kind: "identity_mismatch",
      where: "header.name",
      detail: `Expected "${catalogue.identity.name}"`,
      offending: document.name,
    });
  }
  if (document.email !== catalogue.identity.email) {
    violations.push({
      kind: "identity_mismatch",
      where: "header.email",
      detail: `Expected "${catalogue.identity.email}"`,
      offending: document.email,
    });
  }

  // ── Density limits ───────────────────────────────────────────────────────
  if (document.skills.length > LIMITS.maxSkillLines) {
    violations.push({
      kind: "limit_exceeded",
      where: "skills",
      detail: `${document.skills.length} skill lines exceeds ${LIMITS.maxSkillLines}`,
    });
  }
  const bulletCount = countBullets(document);
  if (bulletCount > LIMITS.maxBullets) {
    violations.push({
      kind: "limit_exceeded",
      where: "experience",
      detail: `${bulletCount} bullets exceeds ${LIMITS.maxBullets}`,
    });
  }

  // ── Fact ids ─────────────────────────────────────────────────────────────
  // A claim citing a fact that does not exist is the simplest fabrication, and
  // the easiest for a model to produce when it wants to say something true-ish.
  for (const factId of referencedFactIds(document)) {
    if (!catalogue.facts.has(factId)) {
      violations.push({
        kind: "unknown_fact_id",
        where: "factIds",
        detail: `No approved fact with id "${factId}"`,
        offending: factId,
      });
    }
  }

  // ── Employers, dates, and binding ────────────────────────────────────────
  for (const [index, entry] of document.experience.entries()) {
    const where = `experience[${index}]`;

    if (!catalogue.employers.has(entry.employer)) {
      violations.push({
        kind: "unknown_employer",
        where,
        detail: "Employer is not in the approved history",
        offending: entry.employer,
      });
      // Later per-employer checks would be meaningless; skip them.
      continue;
    }

    const approvedDates = catalogue.employerDates.get(entry.employer);
    if (approvedDates !== undefined && entry.dates !== approvedDates) {
      violations.push({
        kind: "altered_dates",
        where: `${where}.dates`,
        detail: `Expected "${approvedDates}"`,
        offending: entry.dates,
      });
    }

    // Employer/project binding: a technology may be true of the candidate and
    // still false of THIS employer. Claiming Convex at Roomvu would be a
    // fabrication built entirely from approved facts.
    const allowedHere = catalogue.employerTechnologies.get(entry.employer);
    if (allowedHere !== undefined) {
      for (const bullet of entry.bullets) {
        for (const token of extractTokens(bullet.text)) {
          if (!isKnownTechnology(token, catalogue)) continue;
          if (catalogue.bindingExemptAliases.has(token)) continue;
          if (allowedHere.has(token)) continue;
          violations.push({
            kind: "employer_binding",
            where: `${where}.bullets`,
            detail: `"${token}" is approved, but not for ${entry.employer}`,
            offending: token,
          });
        }
      }
    }

    for (const bullet of entry.bullets) {
      collectTextViolations(bullet.text, `${where}.bullets`, catalogue, violations);
    }
  }

  // ── Summary and skills prose ─────────────────────────────────────────────
  collectTextViolations(document.summary.text, "summary", catalogue, violations);
  for (const [index, skill] of document.skills.entries()) {
    collectTextViolations(skill.items, `skills[${index}]`, catalogue, violations);
  }

  // ── Seniority ────────────────────────────────────────────────────────────
  for (const word of SENIORITY_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`, "i");
    if (!pattern.test(document.title)) continue;
    if (catalogue.seniorityWords.has(word)) continue;
    violations.push({
      kind: "seniority_inflation",
      where: "header.title",
      detail: `Seniority "${word}" is not supported by the approved history`,
      offending: word,
    });
  }

  return { ok: violations.length === 0, violations, ruleVersion: VALIDATOR_RULE_VERSION };
}

/**
 * Validate a cover letter against the same approved catalogue.
 *
 * Spec Phase 5 deliverable 7. Every check the resume gets, a letter gets:
 * identity, known fact ids, unsupported technologies, unsupported metrics,
 * confirmed gaps, and employer binding for any paragraph that names an
 * employer.
 *
 * The one addition is masking. A letter necessarily contains the target
 * company's name and the posting's job title, and both are capitalized proper
 * nouns — exactly what `looksLikeTechnology` treats as a technology. Left
 * unmasked, writing to "Mollie" about a "Staff Platform Engineer" role reports
 * two fabrications that are not fabrications. They are masked because they are
 * quoted from the posting, not claims about the candidate.
 */
export function validateCoverLetter(
  letter: CoverLetter,
  catalogue: ApprovedCatalogue,
): ValidationResult {
  const violations: Violation[] = [];

  if (letter.name !== catalogue.identity.name) {
    violations.push({
      kind: "identity_mismatch",
      where: "letter.name",
      detail: `Expected "${catalogue.identity.name}"`,
      offending: letter.name,
    });
  }
  if (letter.email !== catalogue.identity.email) {
    violations.push({
      kind: "identity_mismatch",
      where: "letter.email",
      detail: `Expected "${catalogue.identity.email}"`,
      offending: letter.email,
    });
  }

  if (letter.paragraphs.length > COVER_LETTER_LIMITS.maxParagraphs) {
    violations.push({
      kind: "limit_exceeded",
      where: "paragraphs",
      detail: `${letter.paragraphs.length} paragraphs exceeds ${COVER_LETTER_LIMITS.maxParagraphs}`,
    });
  }
  const totalChars = coverLetterLength(letter);
  if (totalChars > COVER_LETTER_LIMITS.maxTotalChars) {
    violations.push({
      kind: "limit_exceeded",
      where: "paragraphs",
      detail: `${totalChars} characters exceeds ${COVER_LETTER_LIMITS.maxTotalChars}`,
    });
  }

  for (const factId of coverLetterFactIds(letter)) {
    if (!catalogue.facts.has(factId)) {
      violations.push({
        kind: "unknown_fact_id",
        where: "factIds",
        detail: `No approved fact with id "${factId}"`,
        offending: factId,
      });
    }
  }

  // Quoted or self-evident, never a claim about capability: the target company,
  // the posting's title, and the candidate's own approved employers.
  const quoted = [letter.company, letter.roleTitle, ...catalogue.employers];

  for (const [index, paragraph] of letter.paragraphs.entries()) {
    const where = `paragraphs[${index}]`;
    const text = maskPhrases(paragraph.text, quoted);

    if (paragraph.employer !== undefined) {
      if (!catalogue.employers.has(paragraph.employer)) {
        violations.push({
          kind: "unknown_employer",
          where,
          detail: "Employer is not in the approved history",
          offending: paragraph.employer,
        });
      } else {
        const allowedHere = catalogue.employerTechnologies.get(paragraph.employer);
        if (allowedHere !== undefined) {
          for (const token of extractTokens(text)) {
            if (!isKnownTechnology(token, catalogue)) continue;
            if (catalogue.bindingExemptAliases.has(token)) continue;
            if (allowedHere.has(token)) continue;
            violations.push({
              kind: "employer_binding",
              where,
              detail: `"${token}" is approved, but not for ${paragraph.employer}`,
              offending: token,
            });
          }
        }
      }
    }

    collectTextViolations(text, where, catalogue, violations);
  }

  // The greeting and closing carry no claims, but a model can still smuggle one
  // in ("Yours, Candidate — AWS certified"), so they are checked too.
  //
  // The salutation itself is masked first. "Dear Hiring Team," and "Dear Sofia,"
  // are capitalized proper nouns that name the READER — reporting them as
  // fabricated technologies is noise that would train the owner to ignore the
  // violation list. Everything after the salutation's comma is still checked.
  collectTextViolations(
    maskSalutation(maskPhrases(letter.greeting, quoted)),
    "greeting",
    catalogue,
    violations,
  );
  collectTextViolations(maskPhrases(letter.closing, quoted), "closing", catalogue, violations);

  // Seniority is checked on UNMASKED prose, deliberately.
  //
  // Masking the posting's title would let "As a Staff Engineer, I …" through
  // whenever the posting happened to be titled "Staff Engineer" — the exact
  // sentence that must never ship. The cost is that quoting an above-grade
  // title verbatim is refused; the composer therefore keeps the posting's title
  // out of prose entirely and carries it in a structured field.
  for (const [index, paragraph] of letter.paragraphs.entries()) {
    collectSeniorityViolations(paragraph.text, `paragraphs[${index}]`, catalogue, violations);
  }
  collectSeniorityViolations(letter.greeting, "greeting", catalogue, violations);
  collectSeniorityViolations(letter.closing, "closing", catalogue, violations);

  return { ok: violations.length === 0, violations, ruleVersion: VALIDATOR_RULE_VERSION };
}

/**
 * Phrases naming the READER or a colleague, not the candidate.
 *
 * "Dear Hiring Manager" is the most common opening line in the format and
 * contains a seniority word; without this it would be reported as the candidate
 * claiming to be a manager. Masked before the seniority scan.
 */
const READER_PHRASES = [
  "hiring manager",
  "hiring team",
  "engineering manager",
  "product manager",
  "recruiting team",
  "recruiting manager",
];

/**
 * Validate an outreach message (spec Phase 5 deliverable 6).
 *
 * Same allowlist as everything else, with one addition: the caller passes the
 * strings that are QUOTED rather than claimed — the company name, the posting's
 * title, a recruiter's name, a product the company makes. Those are masked
 * before analysis.
 *
 * The `quoted` list is the deliberate escape hatch for hand-written messages.
 * A capitalized noun the catalogue has never heard of is indistinguishable from
 * a fabricated technology, so rather than weakening the check for typed text,
 * the owner declares what is a quotation. The declaration is stored with the
 * draft, so the decision is auditable instead of invisible.
 */
export function validateOutreachText(
  message: { subject?: string; body: string; factIds: string[] },
  catalogue: ApprovedCatalogue,
  quoted: string[] = [],
): ValidationResult {
  const violations: Violation[] = [];

  for (const factId of message.factIds) {
    if (!catalogue.facts.has(factId)) {
      violations.push({
        kind: "unknown_fact_id",
        where: "factIds",
        detail: `No approved fact with id "${factId}"`,
        offending: factId,
      });
    }
  }

  const parts: Array<{ text: string; where: string }> = [
    { text: message.body, where: "body" },
  ];
  if (message.subject !== undefined && message.subject.trim() !== "") {
    parts.push({ text: message.subject, where: "subject" });
  }

  for (const part of parts) {
    const masked = maskSalutation(maskPhrases(part.text, quoted));
    collectTextViolations(masked, part.where, catalogue, violations);
    collectSeniorityViolations(part.text, part.where, catalogue, violations);
  }

  return { ok: violations.length === 0, violations, ruleVersion: VALIDATOR_RULE_VERSION };
}

/** Flag seniority words the approved history does not support. */
function collectSeniorityViolations(
  text: string,
  where: string,
  catalogue: ApprovedCatalogue,
  violations: Violation[],
): void {
  const scanned = maskPhrases(text, READER_PHRASES);

  for (const word of SENIORITY_WORDS) {
    if (catalogue.seniorityWords.has(word)) continue;
    if (!new RegExp(`\\b${word}\\b`, "i").test(scanned)) continue;
    violations.push({
      kind: "seniority_inflation",
      where,
      detail: `Seniority "${word}" is not supported by the approved history`,
      offending: word,
    });
  }
}

/** Blank out a leading salutation ("Dear …,"), preserving offsets. */
function maskSalutation(text: string): string {
  return text.replace(/^\s*(?:dear|hello|hi|greetings)\b[^,\n]*,/i, (match) =>
    " ".repeat(match.length),
  );
}

/** Blank out literal phrases, preserving offsets so sentence starts still line up. */
function maskPhrases(text: string, phrases: string[]): string {
  let masked = text;
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    const trimmed = phrase.trim();
    if (trimmed.length === 0) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    masked = masked.replace(new RegExp(escaped, "gi"), (match) => " ".repeat(match.length));
  }
  return masked;
}

function extractTokens(text: string): string[] {
  return (text.match(TECH_TOKEN) ?? []).map(normalizeToken);
}

/** Whether a token names a technology present in the approved catalogue. */
function isKnownTechnology(token: string, catalogue: ApprovedCatalogue): boolean {
  for (const aliases of catalogue.facts.values()) {
    if (aliases.includes(token)) return true;
  }
  return false;
}

/**
 * Whether a token is shaped like a product or technology name.
 *
 * The first design checked EVERY word against a prose allowlist, which does
 * not scale — a realistic bullet flagged "video", "consultations", "payment",
 * "flows", "loading", and "Server". Enumerating English is not a strategy.
 *
 * So detection is now shape-based. A technology name is almost always one of:
 *
 *   - internal punctuation      Next.js, CI/CD, C++, C#, Node.js
 *   - internal capitalization   TypeScript, PostgreSQL, GraphQL, WebRTC
 *   - an all-caps acronym       AWS, SQL, WCAG, EOR
 *   - a capitalized proper noun Kubernetes, Angular, Ruby, Svelte
 *
 * Ordinary lowercase prose is none of these, so it is not examined at all.
 * `isSentenceStart` suppresses the last rule for the first word of a sentence,
 * where capitalization carries no information.
 */
function looksLikeTechnology(raw: string, isSentenceStart: boolean): boolean {
  if (/[.+#/]/.test(raw.slice(1))) return true;
  if (/[a-z][A-Z]/.test(raw)) return true;
  if (/^[A-Z0-9]{2,}$/.test(raw)) return true;
  if (!isSentenceStart && /^[A-Z][a-z]/.test(raw)) return true;
  return false;
}

/**
 * Check free text for unsupported technologies and metrics.
 *
 * Technologies: any technology-shaped token must resolve to an approved alias.
 * This is what stops a model quietly adding "Kubernetes" to a skills line.
 *
 * Metrics: every number making a claim must appear in the master. A model that
 * improves "15%" to "50%" fabricates in the most damaging way, because the
 * sentence around it still reads as true.
 */
function collectTextViolations(
  text: string,
  where: string,
  catalogue: ApprovedCatalogue,
  violations: Violation[],
): void {
  const seen = new Set<string>();

  // Offsets that begin a sentence, where capitalization means nothing.
  const sentenceStarts = new Set<number>([0]);
  for (const match of text.matchAll(/[.!?]\s+|\n+/g)) {
    sentenceStarts.add((match.index ?? 0) + match[0].length);
  }

  // Multi-word approved aliases ("App Router", "Server Components") are matched
  // and masked out before tokenizing. Otherwise their individual words —
  // "Router", "Server" — are examined alone and flagged as unknown.
  const masked = maskMultiWordAliases(text, catalogue);

  for (const match of masked.matchAll(TECH_TOKEN)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    const token = normalizeToken(raw);

    if (token.length < 2) continue;
    if (/^\d+$/.test(token)) continue;

    // A confirmed gap is always a violation, never suppressed by heuristics.
    if (catalogue.knownGaps.has(token)) {
      if (seen.has(token)) continue;
      seen.add(token);
      violations.push({
        kind: "unsupported_technology",
        where,
        detail: `"${raw}" is a confirmed gap and must not appear`,
        offending: raw,
      });
      continue;
    }

    if (PROSE_ALLOWLIST.has(token)) continue;
    if (!looksLikeTechnology(raw, sentenceStarts.has(offset))) continue;
    if (seen.has(token)) continue;
    seen.add(token);

    if (isKnownTechnology(token, catalogue)) continue;
    if (catalogue.employers.has(raw)) continue;

    violations.push({
      kind: "unsupported_technology",
      where,
      detail: `"${raw}" is not an approved fact alias`,
      offending: raw,
    });
  }

  for (const raw of text.match(METRIC_TOKEN) ?? []) {
    const metric = normalizeMetric(raw);
    // Bare small integers ("4 production apps") are counted as prose, not as
    // metric claims; the catalogue records the ones that matter.
    if (/^\d{1,2}$/.test(metric)) continue;
    if (catalogue.metrics.has(metric)) continue;

    violations.push({
      kind: "unsupported_metric",
      where,
      detail: `Metric "${raw}" does not appear in the approved history`,
      offending: raw,
    });
  }
}

/**
 * Replace multi-word approved aliases with spaces so they are not tokenized
 * into their component words.
 *
 * "App Router" and "Server Components" are single approved concepts; examined
 * word by word they become the unknown tokens "Router" and "Server". Longest
 * aliases are masked first so a longer phrase wins over a shorter prefix.
 */
function maskMultiWordAliases(text: string, catalogue: ApprovedCatalogue): string {
  const phrases: string[] = [];
  for (const aliases of catalogue.facts.values()) {
    for (const alias of aliases) {
      if (alias.includes(" ")) phrases.push(alias);
    }
  }
  phrases.sort((a, b) => b.length - a.length);

  let masked = text;
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    masked = masked.replace(new RegExp(escaped, "gi"), (match) => " ".repeat(match.length));
  }
  return masked;
}
