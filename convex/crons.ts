import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Background work inside the local backend. The agents themselves run on the
 * Mac (launchd); these only touch Gmail and tidy the queue.
 *
 * No argument here may be time-dependent: cron arguments are serialized once at
 * deploy time, so handlers read the clock themselves.
 */
const crons = cronJobs();

/** Learn which drafts were sent, catch replies, and write 7-day follow-up drafts. */
crons.interval("sync gmail threads", { minutes: 15 }, internal.gmail.node.syncInbox, {});

/** Forget long-scored postings so the seen-list stays small. */
crons.interval("prune scored postings", { hours: 24 }, internal.postings.prune, {});

export default crons;
