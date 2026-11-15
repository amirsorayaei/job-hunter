# Job Hunter

Automates Candidate's daily job-search routine. The dashboard and database are online
(Vercel + Convex cloud, https://job-hunter-lemon-seven.vercel.app); the agents
run on his Mac:

1. **Find** remote / visa-sponsored / Turkey roles that fit his two resumes.
2. **Prepare** the good ones: a tailored one-page resume, and, when the employer
   takes email, a **Gmail draft** with the resume attached.
3. **Track** what happened: sent, waiting, replied, interview, follow-up after
   7 days of silence (also a Gmail draft).

Nothing is ever sent by the app. You schedule the drafts in Gmail yourself.

## Pieces

| Part | What it does | When |
|---|---|---|
| Collector (`pnpm agent:collect`) | Reads every company board in the catalog + RemoteOK, Remotive, Himalayas, Arbeitnow, HN Who is hiring. Filters, dedupes, queues. **No tokens.** | hourly :50 |
| Frontend agent (`pnpm agent:score --track frontend`) | Claude (Sonnet) scores the queued frontend postings; at 10:00 and 22:00 it also searches the open web (Sonnet). | hourly :00 |
| Full-Stack agent (`pnpm agent:score --track fullstack`) | Same for full-stack. | hourly :00 |
| Company finder (`pnpm agent:companies`) | Claude finds new companies' job boards; each is verified before it is added. | daily 12:00 |
| Prep agent (`pnpm agent:prep`) | Tailors the resume from `resume-source/`, writes the email, verifies the recipient address, creates the Gmail draft. | hourly :30 |
| Backend | Convex cloud `third-spoonbill-63` (database + Gmail sync every 15 min). | always on |
| Dashboard | Vercel, works on the phone — Dashboard, Roles, Settings. | always on |

Roles scoring 80+ are prepared automatically (max 15 a day); change both in Settings.
An email draft is created **only** when a real hiring address was found on the
employer's own page and its domain accepts mail. Otherwise the role is a form
role: open the link, apply, tick **Applied**.

## Run

```bash
bash scripts/install-agents.sh          # installs the 5 agents (launchd)
bash scripts/install-agents.sh --remove # removes them all
```

Agents reach the cloud through `AGENT_INGEST_URL` in `~/.config/job-hunter/agent.env`.
Models and the web-search interval are set there too: `SCORE_MODEL`, `EXPLORE_MODEL`,
`COMPANIES_MODEL`, `PREP_MODEL` (opus | sonnet | haiku), `EXPLORE_HOURS` (default `10,22`).
Pause them from Settings. Logs: `agent/logs/`. Sign-in details:
`.owner-login.local.txt` (not in git).

Deploy: `npx convex deploy -y` (backend), `vercel deploy --prod` (dashboard).

Development: `pnpm dev` against the cloud dev deployment in `.env.local`, `pnpm test`,
`pnpm test:convex`, `pnpm typecheck`, `pnpm lint`.
