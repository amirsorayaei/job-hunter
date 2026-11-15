/**
 * The candidate profile and approved fact catalog.
 *
 * Spec 6.1 and 3.2: every generated claim must map to an approved fact id, and
 * the profile is versioned so an assessment can be traced to the constraints it
 * was computed against.
 *
 * Facts here mirror `../../../resume_content.py` in the resume workspace, which
 * remains the human source of truth. Nothing may be added here that is not
 * already true there — this file is a machine-readable projection, never a
 * place to invent capability.
 */

/** An approved fact and the phrasings that count as it. */
export interface Fact {
  id: string;
  aliases: string[];
}

export const PROFILE_VERSION = 1;

/**
 * Standing constraints (spec 6.1).
 *
 * Recorded as data so the eligibility rules can be re-run when they change,
 * rather than being spread across prompts and session context.
 */
export const CANDIDATE_PROFILE = {
  version: PROFILE_VERSION,
  currentCountry: "Iran",
  /** Sponsorship or a genuinely location-independent engagement is required. */
  requiresSponsorship: true,
  relocationTargets: ["Turkey"],
  /**
   * Armenia was researched and then explicitly set aside by the candidate.
   * Recorded so nothing re-proposes it.
   */
  relocationExclusions: ["Armenia"],
  workAuthorizations: [] as string[],
  remoteEngagementPolicy:
    "Remote from anywhere, or an employer able to engage a non-resident (contractor/EOR). " +
    "Never misrepresent location.",
  bankingReadiness: "unresolved" as const,
  languageLevels: [
    { language: "English", level: "B2" },
    { language: "Persian", level: "native" },
  ],
} as const;

/**
 * Approved facts.
 *
 * `aliases` are the literal strings that count as an exact match. Anything not
 * listed scores zero — there is no fuzzy credit.
 */
export const FACTS: Fact[] = [
  // ── Role and seniority ───────────────────────────────────────────────────
  // These were initially missing, which made the rubric score its own title
  // and seniority requirements at zero: the posting said "Senior Frontend",
  // the scanner found it, and then had no fact to match it against. They are
  // as much approved facts as any technology.
  { id: "role-frontend", aliases: ["frontend", "front-end", "front end", "ui engineer"] },
  { id: "role-fullstack", aliases: ["full stack", "full-stack", "fullstack"] },
  { id: "role-software-engineer", aliases: ["software engineer", "web developer"] },
  // Senior and Lead are both held titles. "Staff" and "Principal" are NOT,
  // and are deliberately absent.
  { id: "seniority-senior", aliases: ["senior", "lead"] },
  // 7+ years, so every lower threshold is satisfied too.
  {
    id: "experience-7y",
    aliases: ["3+ years", "4+ years", "5+ years", "6+ years", "7+ years"],
  },

  // ── Technologies ─────────────────────────────────────────────────────────
  { id: "typescript", aliases: ["typescript", "ts"] },
  { id: "javascript", aliases: ["javascript", "es6", "ecmascript"] },
  { id: "react", aliases: ["react", "react.js", "reactjs"] },
  { id: "nextjs", aliases: ["next.js", "nextjs", "next js"] },
  { id: "node", aliases: ["node.js", "nodejs", "node"] },
  { id: "express", aliases: ["express", "express.js"] },
  { id: "html-css", aliases: ["html", "html5", "css", "css3", "scss", "sass"] },
  { id: "tailwind", aliases: ["tailwind", "tailwind css"] },
  { id: "styled-components", aliases: ["styled components", "styled-components"] },
  { id: "css-modules", aliases: ["css modules"] },
  { id: "radix", aliases: ["radix", "radix ui"] },
  { id: "shadcn", aliases: ["shadcn", "shadcn/ui"] },
  { id: "material-ui", aliases: ["material ui", "mui"] },
  { id: "ant-design", aliases: ["ant design", "antd"] },
  { id: "storybook", aliases: ["storybook"] },
  { id: "design-systems", aliases: ["design system", "design systems", "component library"] },
  { id: "redux", aliases: ["redux", "redux toolkit"] },
  { id: "zustand", aliases: ["zustand"] },
  { id: "jotai", aliases: ["jotai"] },
  { id: "react-query", aliases: ["react query", "tanstack query", "tanstack"] },
  { id: "react-hook-form", aliases: ["react hook form"] },
  { id: "graphql", aliases: ["graphql"] },
  { id: "rest", aliases: ["rest", "rest api", "restful", "rest apis"] },
  { id: "jest", aliases: ["jest"] },
  { id: "rtl", aliases: ["react testing library", "testing library"] },
  { id: "playwright", aliases: ["playwright"] },
  { id: "cypress", aliases: ["cypress"] },
  { id: "vite", aliases: ["vite"] },
  { id: "webpack", aliases: ["webpack"] },
  { id: "turbopack", aliases: ["turbopack"] },
  { id: "git", aliases: ["git", "github"] },
  { id: "ci-cd", aliases: ["ci/cd", "github actions", "continuous integration"] },
  { id: "docker", aliases: ["docker"] },
  { id: "vercel", aliases: ["vercel"] },
  { id: "ssr", aliases: ["ssr", "ssg", "ssr/ssg", "server-side rendering", "server side rendering"] },
  { id: "server-components", aliases: ["server components", "app router", "rsc"] },
  { id: "performance", aliases: ["core web vitals", "web performance", "code splitting", "lazy loading"] },
  { id: "responsive", aliases: ["responsive", "responsive design", "mobile-first", "mobile first"] },
  { id: "pwa", aliases: ["pwa", "progressive web app", "service worker"] },
  { id: "webrtc", aliases: ["webrtc", "daily.co"] },
  { id: "websockets", aliases: ["websocket", "websockets", "real-time", "realtime"] },
  { id: "stripe", aliases: ["stripe", "payments"] },
  { id: "mongodb", aliases: ["mongodb", "mongo"] },
  { id: "postgres", aliases: ["postgresql", "postgres"] },
  { id: "convex", aliases: ["convex", "serverless"] },
  { id: "i18n", aliases: ["i18n", "internationalization", "localization"] },
  { id: "agile", aliases: ["agile", "scrum", "kanban", "agile/scrum"] },
  { id: "solid", aliases: ["solid", "solid principles"] },
  { id: "code-review", aliases: ["code review", "code reviews", "mentoring"] },
  { id: "vue", aliases: ["vue"] },
  { id: "react-native", aliases: ["react native"] },
  { id: "seo", aliases: ["seo"] },
  { id: "auth", aliases: ["oauth", "authentication", "authorization", "sso"] },

  // Named products and features actually worked on. Registered as multi-word
  // aliases so masking removes them before tokenizing — otherwise "Listing",
  // "Videos", and "Google" are examined alone and read as unknown.
  { id: "google-one-tap", aliases: ["google one-tap sign-in", "google one-tap", "one-tap sign-in"] },
  { id: "roomvu-listing-videos", aliases: ["listing videos"] },

  // Employers by their short names, and products named in the evidence ledger.
  { id: "employer-names", aliases: ["levita health", "levita", "roomvu", "a.p.p software solutions", "a.p.p", "top menu", "topmenu", "hoomaan"] },
  { id: "levita-google-meet", aliases: ["google meet"] },

  // ── Domains actually worked in ───────────────────────────────────────────
  { id: "domain-payments", aliases: ["payments", "fintech"] },
  { id: "domain-marketplace", aliases: ["marketplace", "e-commerce", "ecommerce"] },
  { id: "domain-healthcare", aliases: ["healthcare", "telemedicine"] },
  { id: "domain-saas", aliases: ["saas"] },
];

/**
 * Technologies deliberately absent from the catalog.
 *
 * Listed so the omissions are visible and intentional, not oversights. Each is
 * something the candidate has confirmed he does NOT have; a posting requiring
 * one must score zero for it.
 */
export const KNOWN_GAPS = [
  "kubernetes", "k8s", "angular", "svelte", "ember", "ember.js", "lit",
  "ruby", "rails", "php", "laravel", "java", "spring", "golang", "go",
  "python", "django", "rust", ".net", "c#", "wcag", "accessibility",
  "aws", "gcp", "azure", "terraform", "kafka", "elasticsearch",
] as const;

