/**
 * Startup agent: every two days, searches the open web for early-stage
 * companies and small teams that are hiring, where a founder is easiest to
 * reach. Cron fires it daily; it skips itself when the last run is too recent
 * (it is the most expensive agent, so it runs at most every 2 days).
 *
 *   pnpm agent:startups
 */
import { discover } from "./discovery";
import { readState, runAgent, writeState } from "./lib";

const EVERY_MS = 2 * 24 * 3_600_000 - 2 * 3_600_000; // 2 days, minus 2h slack for cron drift

void runAgent(
  "startups",
  async (log, settings) => {
    writeState("startups-last", { lastAt: Date.now() });
    return discover(log, settings.exploreModel, { promptName: "startups", source: "startup search" });
  },
  {
    skipIf: () =>
      Date.now() - (readState<{ lastAt?: number }>("startups-last", {}).lastAt ?? 0) >= EVERY_MS
        ? undefined
        : "ran recently",
  },
);
