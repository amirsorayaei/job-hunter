/**
 * Web search agent: at the hours chosen in Settings, one search of the open web
 * for BOTH tracks (frontend and full-stack), covering what the collector cannot
 * reach. It replaces the two separate per-track searches, which overlapped.
 *
 *   pnpm agent:explore [--now]
 */
import { discover } from "./discovery";
import { readState, runAgent, writeState } from "./lib";

const MIN_GAP_MS = 3 * 60 * 60 * 1000;
const force = process.argv.includes("--now");

function due(exploreHours: number[]): boolean {
  const last = readState<{ lastAt?: number }>("explore-all", {}).lastAt ?? 0;
  return force || (exploreHours.includes(new Date().getHours()) && Date.now() - last >= MIN_GAP_MS);
}

void runAgent(
  "explore",
  async (log, settings) => {
    writeState("explore-all", { lastAt: Date.now() });
    return discover(log, settings.exploreModel, { promptName: "explore", source: "web search" });
  },
  { skipIf: (settings) => (due(settings.exploreHours) ? undefined : "not a web search hour") },
);
