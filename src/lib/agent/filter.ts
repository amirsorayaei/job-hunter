/**
 * The collector's zero-token filter: which postings are worth a scorer's time.
 *
 * Deliberately generous on the edges: a borderline posting costs a few
 * hundred tokens to score, a wrongly dropped one costs a job. What it removes
 * is the obvious noise: non-developer titles, stacks Candidate does not have, and
 * on-site roles with no remote option, no Turkey location and no visa help.
 */

export type Track = "frontend" | "fullstack";

const DEV_TITLE =
  /\b(front[\s-]?end|full[\s-]?stack|react(\.?js)?|next\.?js|javascript|typescript|node(\.?js)?|web (developer|engineer)|ui (developer|engineer)|software (engineer|developer)|product (engineer|developer)|founding engineer|application (engineer|developer)|design engineer|ai (product |application )?engineer)\b/i;

const NOT_FOR_CANDIDATE =
  /\b(intern(ship)?|working student|werkstudent|trainee|apprentice|graduate|junior|principal|director|head of|vp|vice president|manager|android|ios|swift|kotlin|flutter|react native|mobile|data (engineer|scientist|analyst)|machine learning|ml engineer|research(er)?|devops|platform|infrastructure|cloud|systems|network|sre|site reliability|security|qa|quality|test(ing)?|sdet|embedded|firmware|hardware|salesforce|sap|servicenow|support|sales|designer|recruiter|analyst|java(?!script)|\.net|c#|c\+\+|golang|rust|ruby|rails|php|laravel|angular|scala|elixir|unity|game|blockchain protocol|solidity)\b/i;

/** Is this a developer title Candidate could plausibly hold? */
export function isRelevantTitle(title: string): boolean {
  const clean = title.replace(/[()[\]]/g, " ");
  if (!DEV_TITLE.test(clean)) return false;
  if (NOT_FOR_CANDIDATE.test(clean)) return false;
  // Backend-only titles qualify only when the stack is JavaScript/TypeScript.
  if (/\bback[\s-]?end\b/i.test(clean) && !/\b(node|typescript|javascript|full)/i.test(clean)) return false;
  return true;
}

/**
 * Frontend agent or Full-Stack agent (owner's rule, 2026-11-15): the title decides.
 * "Frontend" in the title → Frontend (his strongest area, and the Frontend
 * baseline resume); "Full Stack" in the title → Full-Stack. Only titles that
 * say neither fall back to the other hints, and anything unclear goes to Full-Stack.
 */
export function trackFor(title: string): Track {
  const clean = title.toLowerCase();
  if (/front[\s-]?end/.test(clean)) return "frontend";
  if (/full[\s-]?stack/.test(clean)) return "fullstack";
  if (/front[\s-]?end|\breact\b|\bui (developer|engineer)|design engineer|web (developer|engineer)|javascript|next\.?js/.test(clean)) {
    return "frontend";
  }
  return "fullstack";
}

const REMOTE = /\b(remote|anywhere|worldwide|distributed|work from home|wfh|fully remote)\b/i;
const TURKEY = /\b(turkey|türkiye|turkiye|istanbul|i̇stanbul|ankara|izmir|i̇zmir)\b/i;
const VISA =
  /\b(visa sponsorship|sponsor(ship)? (your |a |the )?(work )?visa|visa support|relocation (support|package|assistance|bonus)|we (will |can )?sponsor|blue card sponsorship|relocate (you|to))\b/i;

/**
 * India is excluded everywhere (owner's rule, 2026-11-15): roles located in
 * India, open only to candidates there, or run from an Indian entity. Matched
 * on location, title and company, plus explicit "India only" style wording in
 * the description. A passing mention ("offices in London and Pune") in a long
 * description does not count.
 */
const INDIA_PLACE =
  /\b(india|indian|bharat|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|bombay|new delhi|delhi|ncr|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|cochin|jaipur|chandigarh|coimbatore|indore|trivandrum|thiruvananthapuram|mysore|mysuru|vadodara|nagpur|lucknow|bhubaneswar|visakhapatnam)\b/i;
const INDIA_ONLY =
  /\b(india[\s-]only|only (open )?(to|for) (candidates|applicants|residents|people)? ?(based |located |residing )?in india|(candidates|applicants) (must be |should be )?(based|located|residing) in india|based (out of|in) india|within india|across india|pan[\s-]india|\bIST\b time ?zone|india standard time)\b/i;

export function isIndiaRole(input: { location?: string; title?: string; company?: string; description?: string; remoteWording?: string }): boolean {
  const where = [input.location, input.title, input.company, input.remoteWording].filter(Boolean).join(" ");
  if (INDIA_PLACE.test(where)) return true;
  return INDIA_ONLY.test((input.description ?? "").slice(0, 8000));
}

export type Placement = "remote" | "turkey" | "visa";

/**
 * Why this posting is reachable for Candidate, or null when it is not.
 *
 * `workplaceType` comes from the ATS when it says so; free text is checked too
 * because many boards only write "Remote" in the location or the JD.
 */
export function placementOf(input: {
  workplaceType?: string;
  location: string;
  title: string;
  description: string;
}): Placement | null {
  const where = `${input.location} ${input.title}`;
  if (isIndiaRole(input)) return null;
  if (TURKEY.test(where)) return "turkey";
  if (input.workplaceType === "remote" || REMOTE.test(where)) return "remote";
  const head = input.description.slice(0, 6000);
  if (VISA.test(head)) return "visa";
  // A JD that says "remote" in its opening paragraphs, with no location given.
  if (input.location.trim() === "" && REMOTE.test(head.slice(0, 1500))) return "remote";
  return null;
}

/**
 * Sentences that decide whether Candidate may apply at all: citizenship, clearance,
 * residence, work authorization, sponsorship, on-site/hybrid, time zones.
 * Employers often put them at the END of a posting or in the form questions,
 * past what the scorer reads, so they are pulled out and shown up front.
 */
const ELIGIBILITY =
  /\b(citizen(ship)?|security clearance|clearance|resid(e|es|ent|ents|ence|ency|ing)|authori[sz](ed|ation) to work|work authori[sz]ation|right to work|eligib(le|ility) to work|legally (be )?(able|eligible|authori[sz]ed)|able to work in|sponsor(ship)?|visa|relocat(e|ion)|hybrid|on-?site|in[- ]office|days a week in|time ?zones?|overlap with|(must|need to|required to) (be|live|reside) (in|within|located)|based in|located in|only (open|available|hiring) (to|in|for)|(us|u\.s\.|eu|uk)[- ]only)\b/i;

export function eligibilityLines(text: string, maxChars = 900): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\s[•·▪]\s|\n/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 400);
  const out: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    if (!ELIGIBILITY.test(sentence)) continue;
    if (out.some((line) => line === sentence)) continue;
    if (used + sentence.length > maxChars) break;
    out.push(sentence);
    used += sentence.length;
  }
  return out;
}

/** The posting text a scorer sees: the opening of the JD plus any eligibility lines found anywhere in it. */
export function textForScoring(description: string, openingChars = 3500): string {
  const opening = description.slice(0, openingChars);
  const extra = eligibilityLines(description).filter((line) => !opening.includes(line));
  return extra.length === 0 ? opening : `${opening}\n\n[Eligibility lines from the full posting] ${extra.join(" | ")}`;
}

/**
 * Words that only say WHERE a role is. A company that lists one job once per
 * country ("Senior Engineer | UK | Remote", "... | Germany | Remote") gets one
 * row, not one per country.
 */
const PLACE_WORD =
  /^(remote|hybrid|on-?site|in[- ]office|anywhere|worldwide|global|emea|apac|latam|amer|americas|nasa|north america|south america|europe|eu|uk|us|usa|united states|united kingdom|canada|germany|france|spain|italy|portugal|netherlands|ireland|sweden|norway|denmark|finland|poland|czechia|czech republic|austria|switzerland|belgium|romania|greece|turkey|türkiye|turkiye|israel|uae|india|brazil|mexico|argentina|colombia|chile|australia|new zealand|japan|singapore|philippines|south africa|nigeria|kenya|egypt|london|berlin|paris|amsterdam|dublin|madrid|barcelona|lisbon|munich|stockholm|toronto|vancouver|new york|nyc|san francisco|sf|seattle|austin|boston|chicago|istanbul|warsaw|prague|de|fr|es|nl|ie|se|pl|ca|au|br|mx|tr|ch|at|be|pt|it|dk|no|fi)$/i;

/** "UK", "Remote", "Remote, US", "Berlin / Remote": every part is a place word. */
function isPlace(segment: string): boolean {
  const parts = segment.split(/\s*[,/&]\s*|\s+or\s+/).filter((part) => part.trim() !== "");
  return parts.length > 0 && parts.every((part) => PLACE_WORD.test(part.trim()));
}

export function titleKey(company: string, title: string): string {
  const base = title
    .replace(/\(([^)]*)\)/g, (match, inner: string) => (isPlace(inner.trim()) ? " " : match))
    .split(/\s[|–—-]\s|\s[|]\s?|\s?[|]\s/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && !isPlace(segment))
    .join(" ");
  return `${company.trim().toLowerCase()}::${base.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

/** Postings older than this are ignored when the board says when they were posted. */
export const MAX_AGE_DAYS = 45;

export function isFresh(postedAt: string | null | undefined, now: number): boolean {
  if (postedAt === null || postedAt === undefined || postedAt === "") return true;
  const ms = Date.parse(postedAt);
  if (!Number.isFinite(ms)) return true;
  return now - ms <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NOT_A_HIRING_ADDRESS = /(noreply|no-reply|donotreply|privacy|gdpr|dpo|legal|abuse|security|support|billing|press|media|example\.com|sentry|wixpress)/i;

/** Hiring addresses written in the posting itself (the only kind we ever trust). */
export function emailsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0].replace(/\.+$/, "").toLowerCase();
    if (NOT_A_HIRING_ADDRESS.test(address)) continue;
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(address)) continue;
    found.add(address);
  }
  return [...found];
}
