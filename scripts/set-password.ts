/**
 * Choose a new sign-in password for the online app.
 *
 *   pnpm set-password
 *
 * Asks twice (input hidden), then sets it on the production backend. The
 * password goes straight to Convex; it is not stored anywhere on disk.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(1);
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const first = await ask("New password (at least 8 characters): ");
  const second = await ask("Type it again: ");
  if (first !== second) {
    console.error("The two entries do not match. Nothing changed.");
    process.exit(1);
  }
  if (first.length < 8) {
    console.error("Too short. Nothing changed.");
    process.exit(1);
  }
  const result = spawnSync("npx", ["convex", "run", "--prod", "ownerPassword:set", JSON.stringify({ password: first })], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`Failed: ${(result.stderr || result.stdout).split("\n").find((line) => line.includes("Error")) ?? "unknown error"}`);
    process.exit(1);
  }
  console.log("Done. Sign in at https://job-hunter-lemon-seven.vercel.app with your email and this password.");
}

void main();
