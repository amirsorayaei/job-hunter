/**
 * One-off: load agent/companies-seed.json into the company catalog.
 *
 *   pnpm tsx scripts/agent/seed-companies.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR, rpc } from "./lib";

async function main(): Promise<void> {
  const companies = JSON.parse(readFileSync(join(AGENT_DIR, "companies-seed.json"), "utf8")) as unknown[];
  const result = await rpc<{ inserted: number; existing: number }>("companies.upsert", {
  companies,
  addedBy: "seed",
  now: Date.now(),
});
  console.log(`seeded: ${result.inserted} new, ${result.existing} already there`);
}

void main();
