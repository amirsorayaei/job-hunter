#!/usr/bin/env tsx
/**
 * One-command setup for a local deployment — spec Phase 7 criterion 1.
 *
 * "Fresh clone launches with local Convex and synthetic data using documented
 * commands."
 *
 * Generates this deployment's auth keys and its one-time bootstrap secret, and
 * sets them as environment variables. Run it once, after `npx convex dev` has
 * provisioned a deployment.
 *
 * Refuses to touch a CLOUD deployment unless forced. The secrets it generates
 * are for a throwaway local backend, and quietly rotating a production
 * `JWT_PRIVATE_KEY` would sign every existing session out.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_FILE = join(REPO, ".bootstrap-secret.local.txt");

function run(args: string[]): string {
  try {
    return execFileSync("npx", ["convex", ...args], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CONVEX_AGENT_MODE: process.env.CONVEX_AGENT_MODE ?? "anonymous" },
    });
  } catch (caught) {
    // Never echo the argument list: one of these carries a private key.
    const detail = caught instanceof Error ? caught.message.split("\n")[0] : "failed";
    throw new Error(`convex ${args[0]} ${args[1] ?? ""} failed: ${detail.slice(0, 160)}`);
  }
}

function currentDeployment(): string {
  const envFile = join(REPO, ".env.local");
  if (!existsSync(envFile)) {
    throw new Error(
      "No .env.local — run `CONVEX_AGENT_MODE=anonymous npx convex dev` first to provision a local deployment.",
    );
  }
  return readFileSync(envFile, "utf8").match(/^CONVEX_DEPLOYMENT=(.+)$/m)?.[1]?.trim() ?? "";
}

async function main(): Promise<void> {
  const deployment = currentDeployment();
  const isLocal = deployment.startsWith("anonymous:") || deployment.startsWith("local:");

  if (!isLocal && !process.argv.includes("--force")) {
    throw new Error(
      `This is targeting "${deployment}", which is not a local deployment.\n` +
        "Rotating JWT_PRIVATE_KEY there would sign out every existing session.\n" +
        "Re-run with --force only if that is genuinely what you want.",
    );
  }

  console.log(`Setting up ${deployment || "the current deployment"}…`);

  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });

  const bootstrapSecret = randomBytes(24).toString("base64url");
  const llmSecret = randomBytes(32).toString("base64");

  // `--` first: a PEM private key starts with dashes, which the CLI would
  // otherwise read as an option.
  for (const [name, value] of [
    ["JWT_PRIVATE_KEY", privateKey],
    ["JWKS", jwks],
    ["SITE_URL", process.env.SITE_URL ?? "http://localhost:3000"],
    ["OWNER_BOOTSTRAP_SECRET", bootstrapSecret],
    ["LLM_KEY_SECRET", llmSecret],
  ] as Array<[string, string]>) {
    run(["env", "set", "--", name, value]);
    console.log(`  set ${name}`);
  }

  // Written to gitignored files so the values survive a terminal being closed.
  writeFileSync(SECRET_FILE, `${bootstrapSecret}\n`, { mode: 0o600 });

  console.log("");
  console.log("Done. To claim this deployment:");
  console.log("  1. pnpm dev");
  console.log("  2. open http://localhost:3000/signin");
  console.log("  3. enter any email and a password, and paste this bootstrap secret:");
  console.log("");
  console.log(`     ${bootstrapSecret}`);
  console.log("");
  console.log(`  (also saved to ${SECRET_FILE}, which is gitignored)`);
  console.log("");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
