/**
 * The fixed building blocks of an application email.
 *
 * The model never writes the email. It picks which evidence paragraphs to use
 * and writes one opening sentence about the employer; everything else is here,
 * already in Candidate's voice and already checked against the evidence ledger.
 * Every figure below also appears on his resume baselines.
 */

export interface Evidence {
  tracks: Array<"frontend" | "fullstack">;
  /** What the paragraph is about, shown to the model so it can choose. */
  about: string;
  text: string;
}

export const EVIDENCE: Record<string, Evidence> = {
  launch: {
    tracks: ["frontend", "fullstack"],
    about: "taking half-built products to production; Convex; admin portal; conversion lift with PostHog",
    text: "Before I joined Levita Health, their patient and doctor apps existed but were only half built. I took both to production in about two months on a shared Convex backend, then built the admin portal in under three weeks. Patient registration went from below 10% to above 40% once we tested where payment sat in the flow.",
  },
  payments: {
    tracks: ["fullstack"],
    about: "Stripe payments, payouts, wallets, tenant-scoped access",
    text: "At Levita I also built the money side. Patients pay before they book, doctors get roughly 70% in an in-app wallet, and admins approve withdrawals. Access is scoped by role and tenant across five portals, and it fails closed.",
  },
  realtime_ai: {
    tracks: ["fullstack"],
    about: "WebRTC video consultations; LLM report drafts; transcription",
    text: "Doctors there used to run consultations on Google Meet. I moved the call into the product with Daily and WebRTC, and routed the transcript into an AI report draft. Documentation dropped from about 15 minutes to under 5.",
  },
  video_perf: {
    tracks: ["frontend", "fullstack"],
    about: "frontend ownership at scale; performance; HLS; conversion; NPM packages",
    text: "At Roomvu I owned the frontend for Listing Videos on a platform with roughly 400K paid users. On a campaign page, image prioritization and HLS streaming lifted subscribe conversion by about 30%. I also pulled the video players into versioned NPM packages and was the only frontend engineer for the last eight months.",
  },
  bundle: {
    tracks: ["frontend"],
    about: "bundle size, load time, route splitting, TanStack Query, SSR, restaurant product",
    text: "At A.P.P I built the frontend for Top Menu from scratch. It serves 400+ restaurants and about 500K visits a month. The first bundle was 4MB, so I split it by route and cut the initial load from about 2 seconds to under 1, and replaced Redux with TanStack Query and SSR.",
  },
  lead: {
    tracks: ["frontend", "fullstack"],
    about: "leading a small team: sprint planning, hiring, mentoring, code review",
    text: "I've also led a team. At A.P.P I ran sprint planning for 4 to 5 developers, and recruited, onboarded, mentored and reviewed code for them.",
  },
};

/** One honest sentence per known gap. The model picks an id only when the posting requires that thing. */
export const GAPS: Record<string, { about: string; text: string }> = {
  python: {
    about: "Python as a main backend language",
    text: "One honest note: I haven't written production Python. My backend work has been TypeScript on Node and Convex.",
  },
  cloud: {
    about: "AWS, GCP or Azure infrastructure",
    text: "One honest note: I haven't run production AWS, GCP or Azure infrastructure. My deployments have been on Vercel and Cloudflare.",
  },
  devops: {
    about: "Kubernetes, Terraform, heavy DevOps",
    text: "One honest note: I haven't worked with Kubernetes or Terraform. My delivery work is GitLab CI/CD and Docker.",
  },
  systems_langs: {
    about: "Go, Java, Rust, .NET or C# as the main language",
    text: "One honest note: I haven't shipped production Go, Java, Rust or .NET. I'm strongest in TypeScript.",
  },
  ruby: {
    about: "Ruby / Rails",
    text: "One honest note: I haven't worked with Ruby or Rails in production. I'm strongest in TypeScript on React and Node.",
  },
  angular: {
    about: "Angular",
    text: "One honest note: I haven't built production Angular. My frontend work has been React and Next.js.",
  },
  mobile: {
    about: "native mobile (iOS, Android)",
    text: "One honest note: I haven't shipped native mobile apps. I'm strongest on the web.",
  },
  sql: {
    about: "deep SQL / PostgreSQL in production",
    text: "One honest note: my production SQL has been MySQL, not PostgreSQL.",
  },
};

export interface EmailPick {
  opener: string;
  evidence: string[];
  gap: string | null;
}

export function checkPick(pick: EmailPick, track: "frontend" | "fullstack"): string | undefined {
  const words = pick.opener.trim().split(/\s+/).length;
  if (words < 6 || words > 40) return `opener has ${words} words; it must be 6 to 40`;
  if (/[—–]/.test(pick.opener)) return "opener contains a dash";
  if (pick.evidence.length < 1 || pick.evidence.length > 2) return "choose one or two evidence paragraphs";
  for (const id of pick.evidence) {
    const entry = EVIDENCE[id];
    if (entry === undefined || !entry.tracks.includes(track)) return `evidence id ${id} is not available for ${track}`;
  }
  if (pick.gap !== null && GAPS[pick.gap] === undefined) return `unknown gap id ${pick.gap}`;
  return undefined;
}

/** The finished email body. The signature is added later by the Gmail step. */
export function buildEmail(input: { company: string; title: string; pick: EmailPick }): { subject: string; body: string } {
  const team = input.company.replace(/\(.*?\)/g, "").trim() || "hiring";
  const parts = [
    `Hi ${team} team,`,
    input.pick.opener.trim(),
    ...input.pick.evidence.map((id) => EVIDENCE[id]!.text),
    ...(input.pick.gap !== null ? [GAPS[input.pick.gap]!.text] : []),
    "My resume is attached. If it looks close to what you need, I'd be glad to talk.",
    "Thanks,",
  ];
  const cleanTitle = input.title.replace(/\s+/g, " ").trim().slice(0, 70);
  return { subject: `${cleanTitle} application - Your Name`, body: parts.join("\n\n") };
}
