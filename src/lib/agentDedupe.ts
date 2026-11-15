/**
 * Dedupe for the nightly agents, enforced by the runner rather than trusted to
 * the model. The first real Full-Stack run returned four roles the owner had
 * already seen, because the agent ignored its own history check.
 *
 * `normUrl` and `slug` mirror tools/history.py exactly, so a URL that script
 * calls SEEN is SEEN here too.
 */

export interface SeenEntry {
  company?: string;
  role?: string;
  url?: string;
  key?: string;
}

export function normUrl(input: string | undefined): string {
  let u = (input ?? "").trim().replace(/[.,)>"']+$/, "");
  const gh = /[?&]gh_jid=(\d+)/.exec(u) ?? /greenhouse\.io\/[^/?#]+\/jobs\/(\d+)/.exec(u);
  if (gh) return `greenhouse/${gh[1]}`;
  // Hacker News posts differ only by ?id=, which the query strip below would drop.
  const hn = /news\.ycombinator\.com\/item\?id=(\d+)/.exec(u);
  if (hn) return `hn/${hn[1]}`;
  u = u.replace(/[?#].*$/, "").replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.replace(/\/(application|apply)\/?$/, "");
  return u.replace(/\/+$/, "").toLowerCase();
}

export function slug(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "Full-Stack Engineer - ElevenAPI" and "Full-Stack Engineer (Studio)" share a core title. */
function coreTitle(role: string | undefined): string {
  return slug((role ?? "").split(/\s[-–—|(]\s?|\s\(/)[0]);
}

export type Verdict = "new" | "known_company" | "duplicate";

export function classify(
  finding: { company: string; title: string; url: string },
  seen: SeenEntry[],
): Verdict {
  const key = normUrl(finding.url);
  const company = slug(finding.company);
  const title = slug(finding.title);
  const core = coreTitle(finding.title);
  let sameCompany = false;

  for (const entry of seen) {
    if (key !== "" && (entry.key === key || (entry.url !== undefined && normUrl(entry.url) === key))) {
      return "duplicate";
    }
    const entryCompany = slug(entry.company);
    if (entryCompany === "" || company === "") continue;
    // "Poolday (via A-Players)" vs "Poolday": compare on the leading name too.
    const companyMatch =
      entryCompany === company ||
      entryCompany.startsWith(`${company}-`) ||
      company.startsWith(`${entryCompany}-`);
    if (!companyMatch) continue;
    sameCompany = true;

    const role = slug(entry.role);
    if (role === "") continue;
    if (role === title || coreTitle(entry.role) === core || title.includes(role) || role.includes(title)) {
      return "duplicate";
    }
  }
  return sameCompany ? "known_company" : "new";
}
