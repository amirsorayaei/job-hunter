/**
 * Shared plumbing for the Mac agents (collector, frontend, fullstack,
 * companies, prep): config, the Convex RPC, Claude Code headless, logging,
 * a lock so a slow run is never doubled, and run bookkeeping.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveMx } from "node:dns/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { istanbulDate, ISTANBUL_OFFSET_MS } from "../../src/lib/time";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..");
export const WORKSPACE = join(REPO, "..");
export const AGENT_DIR = join(REPO, "agent");
export const STATE_DIR = join(AGENT_DIR, "state");
const LOG_DIR = join(AGENT_DIR, "logs");
const CLAUDE = process.env.CLAUDE_BIN ?? (existsSync("/opt/homebrew/bin/claude") ? "/opt/homebrew/bin/claude" : "claude");

export type AgentName = "collector" | "frontend" | "fullstack" | "companies" | "prep" | "startups" | "explore";

/** What the agents read from the Settings page at the start of every run. */
export interface AgentSettings {
  paused: boolean;
  scoreModel: string;
  exploreModel: string;
  companiesModel: string;
  prepModel: string;
  exploreHours: number[];
  quietFrom: number;
  quietTo: number;
  scoreEveryHours: number;
}

/** True when `hour` falls in the quiet range [from, to), which may wrap midnight. */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

// ── Config and RPC ─────────────────────────────────────────────────────────

interface Config {
  base: string;
  secret: string;
}

let config: Config | undefined;

function loadConfig(): Config {
  if (config !== undefined) return config;
  const file = join(homedir(), ".config", "job-hunter", "agent.env");
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  const base = (values.AGENT_INGEST_URL ?? "").replace(/\/+$/, "").replace(/\/agent\/findings$/, "");
  const secret = values.AGENT_INGEST_SECRET ?? "";
  if (base === "" || secret === "") throw new Error(`${file} must set AGENT_INGEST_URL and AGENT_INGEST_SECRET`);
  config = { base, secret };
  return config;
}

/** Waits (seconds) between tries when the network drops or the server is briefly down: about 8 minutes in all. */
const RETRY_WAITS_S = [15, 45, 120, 300];

async function post(path: string, body: unknown): Promise<unknown> {
  const { base, secret } = loadConfig();
  let response: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status < 500 || attempt >= RETRY_WAITS_S.length) break;
    } catch (error) {
      if (attempt >= RETRY_WAITS_S.length) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAITS_S[attempt]! * 1000));
  }
  const text = await response.text();
  let parsed: { result?: unknown; error?: string } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // fall through
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${parsed.error ?? text.slice(0, 300)}`);
  return parsed.result;
}

/** Call one of the internal functions listed in convex/http.ts. */
export async function rpc<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await post("/agent/rpc", { op, args })) as T;
}

export async function completePrep(body: Record<string, unknown>): Promise<{ drafted: boolean; emailError?: string }> {
  return (await post("/agent/prep/complete", body)) as { drafted: boolean; emailError?: string };
}

// ── Logging, locking, run records ──────────────────────────────────────────

function stamp(ms: number): string {
  return new Date(ms + ISTANBUL_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

export function makeLog(agent: AgentName): (message: string) => void {
  mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, `${istanbulDate(Date.now())}-${agent}.log`);
  return (message: string) => {
    const line = `[${stamp(Date.now())}] ${message}\n`;
    process.stdout.write(line);
    appendFileSync(file, line);
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one agent pass: skip when paused or when the previous pass is still
 * going, and record the outcome so Settings can show it.
 */
export async function runAgent(
  agent: AgentName,
  work: (log: (message: string) => void, settings: AgentSettings) => Promise<string>,
  options: {
    ignorePause?: boolean;
    /** Agents that cost no tokens (the collector) keep running during quiet hours. */
    ignoreQuiet?: boolean;
    /** Return a reason to skip this run quietly (no run record), or undefined to go ahead. */
    skipIf?: (settings: AgentSettings) => string | undefined;
  } = {},
): Promise<void> {
  const log = makeLog(agent);
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = join(STATE_DIR, `${agent}.lock`);
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (Number.isFinite(pid) && alive(pid)) {
      log(`previous ${agent} run (pid ${pid}) is still going; skipping`);
      return;
    }
  }
  writeFileSync(lock, String(process.pid));
  try {
    const settings = await rpc<AgentSettings>("settings.get");
    if (settings.paused && options.ignorePause !== true) {
      log("paused in Settings; nothing to do");
      return;
    }
    if (options.ignoreQuiet !== true && inQuietHours(new Date().getHours(), settings.quietFrom, settings.quietTo)) {
      log(`quiet hours (${settings.quietFrom}:00 to ${settings.quietTo}:00); nothing to do`);
      return;
    }
    const skip = options.skipIf?.(settings);
    if (skip !== undefined) {
      log(`skipped: ${skip}`);
      return;
    }
    const runId = await rpc<string>("runs.start", { agent, now: Date.now() });
    try {
      const summary = await work(log, settings);
      log(`done: ${summary}`);
      const usage = usageSoFar();
      if (usage.calls > 0) log(`usage this run: ${usageLine(usage)}`);
      await rpc("runs.finish", { runId, ok: true, summary, usage: usage.calls > 0 ? usage : undefined, now: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`FAILED: ${message}`);
      const usage = usageSoFar();
      await rpc("runs.finish", { runId, ok: false, error: message, usage: usage.calls > 0 ? usage : undefined, now: Date.now() }).catch(
        () => undefined,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    log(`could not reach the app (is it running?): ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    rmSync(lock, { force: true });
  }
}

// ── State files ────────────────────────────────────────────────────────────

export function readState<T>(name: string, fallback: T): T {
  const file = join(STATE_DIR, `${name}.json`);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeState(name: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${name}.json`), JSON.stringify(value, null, 1));
}

// ── Claude Code, headless, on the owner's subscription ─────────────────────

export interface ClaudeResult {
  structured: unknown;
  text: string;
}

/** What this process has spent on Claude so far (one agent run = one process). */
export interface UsageTally {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** API list price of the same tokens. Informational: the Max plan is not billed per token. */
  costUsd: number;
}

const tally: UsageTally = { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };

/** A folder with nothing in it: run Claude there so no CLAUDE.md is pulled into the prompt. */
export function emptyDir(): string {
  const dir = join(STATE_DIR, "empty");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function usageSoFar(): UsageTally {
  return { ...tally, costUsd: Math.round(tally.costUsd * 1000) / 1000 };
}

function compact(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

export function usageLine(usage: UsageTally): string {
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
  return `${usage.calls} Claude calls, ${compact(total)} tokens (${compact(usage.outputTokens)} written, ${compact(usage.cacheReadTokens)} re-read, ${compact(usage.cacheWriteTokens)} newly cached), about $${usage.costUsd.toFixed(2)} at API prices`;
}

/**
 * `claude -p` with a narrow allowlist. `dontAsk` denies every tool not listed.
 * Permissions go in --settings, not --allowedTools: that flag splits on spaces
 * and breaks rules like "Bash(python3 x:*)".
 */
export function runClaude(input: {
  prompt: string;
  allow: string[];
  schema?: object;
  model?: string;
  /** Reasoning effort for the call. Classification and menu-choosing work needs less than the default. */
  effort?: "low" | "medium" | "high";
  /** Working directory. An empty one keeps the workspace CLAUDE.md out of the prompt. */
  cwd?: string;
  timeoutMin: number;
  log: (message: string) => void;
}): Promise<ClaudeResult> {
  const args = [
    "-p",
    input.prompt,
    "--model",
    input.model ?? "opus",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--settings",
    JSON.stringify({ permissions: { allow: input.allow } }),
    "--strict-mcp-config",
    "--no-session-persistence",
    // Only the tools the allowlist names are loaded. Every tool definition is
    // re-read on every step, so a call with no tools costs about 4k tokens of
    // overhead instead of about 45k.
    "--tools",
    [...new Set(input.allow.map((rule) => rule.replace(/\(.*$/, "")))].join(","),
  ];
  if (input.schema !== undefined) args.push("--json-schema", JSON.stringify(input.schema));
  if (input.effort !== undefined) args.push("--effort", input.effort);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: input.cwd ?? WORKSPACE, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude timed out after ${input.timeoutMin} minutes`));
    }, input.timeoutMin * 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderr.trim() !== "") input.log(`claude stderr: ${stderr.trim().slice(0, 600)}`);
      let envelope: {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
        subtype?: string;
        num_turns?: number;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          output_tokens?: number;
        };
      };
      try {
        envelope = JSON.parse(stdout) as typeof envelope;
      } catch {
        reject(new Error(`claude exited ${code} without JSON output: ${stdout.slice(0, 300)}`));
        return;
      }
      // Count the tokens even when the call failed: they were still spent.
      const usage = envelope.usage;
      if (usage !== undefined) {
        const call = {
          input: usage.input_tokens ?? 0,
          read: usage.cache_read_input_tokens ?? 0,
          write: usage.cache_creation_input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
        };
        tally.calls += 1;
        tally.inputTokens += call.input;
        tally.cacheReadTokens += call.read;
        tally.cacheWriteTokens += call.write;
        tally.outputTokens += call.output;
        tally.costUsd += envelope.total_cost_usd ?? 0;
        input.log(
          `  tokens (${input.model ?? "opus"}): ${compact(call.input + call.read + call.write + call.output)} total, ` +
            `${compact(call.output)} written by the model, ${compact(call.read)} re-read from cache, ${compact(call.write)} newly cached, ` +
            `${envelope.num_turns ?? "?"} turns, about $${(envelope.total_cost_usd ?? 0).toFixed(2)} at API prices`,
        );
      }
      if (envelope.is_error === true) {
        reject(new Error(`claude error (${envelope.subtype ?? "unknown"}): ${(envelope.result ?? "").slice(0, 300)}`));
        return;
      }
      let structured = envelope.structured_output;
      if (structured === undefined && typeof envelope.result === "string") {
        const match = /\{[\s\S]*\}\s*$/.exec(envelope.result);
        if (match) {
          try {
            structured = JSON.parse(match[0]);
          } catch {
            structured = undefined;
          }
        }
      }
      resolve({ structured, text: envelope.result ?? "" });
    });
  });
}

export function prompt(name: string, values: Record<string, string> = {}): string {
  let text = readFileSync(join(AGENT_DIR, "prompts", `${name}.md`), "utf8");
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value);
  return text;
}

// ── Seen history (the workspace's job-search-history.json) ─────────────────

export interface SeenEntry {
  company?: string;
  role?: string;
  url?: string;
  key?: string;
}

export function seenHistory(): SeenEntry[] {
  const out: SeenEntry[] = [];
  try {
    const history = JSON.parse(readFileSync(join(WORKSPACE, "job-search-history.json"), "utf8")) as {
      entries?: SeenEntry[];
    };
    out.push(...(history.entries ?? []));
  } catch {
    // no history file: nothing seen
  }
  try {
    out.push(...(JSON.parse(readFileSync(join(AGENT_DIR, "seen-seed.json"), "utf8")) as SeenEntry[]));
  } catch {
    // optional
  }
  return out;
}

// ── Email checks ───────────────────────────────────────────────────────────

/**
 * True when the address's domain accepts mail (has an MX record).
 *
 * Asked over DNS-over-HTTPS first: plain DNS (UDP 53) to public resolvers is
 * refused on the owner's network, which made every domain look mail-less.
 * When no lookup can be made at all, the address is accepted: it has already
 * been seen on the employer's own page, and a network problem is not evidence.
 */
export async function domainAcceptsMail(address: string): Promise<boolean> {
  const domain = address.split("@")[1];
  if (domain === undefined || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return false;
  for (const base of ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"]) {
    try {
      const response = await fetch(`${base}?name=${encodeURIComponent(domain)}&type=MX`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { Status?: number; Answer?: Array<{ type?: number }> };
      if (body.Status === 3) return false; // NXDOMAIN: the domain does not exist
      return (body.Answer ?? []).some((answer) => answer.type === 15);
    } catch {
      // try the next resolver
    }
  }
  try {
    return (await resolveMx(domain)).length > 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return !(code === "ENOTFOUND" || code === "ENODATA");
  }
}

/** Fetch a page as text (for confirming an address really appears on it). */
export async function pageText(url: string): Promise<string> {
  // news.ycombinator.com answers Node's fetch with 419; its Algolia API serves the same text.
  const hn = /news\.ycombinator\.com\/item\?id=(\d+)/.exec(url);
  if (hn !== null) {
    const item = await fetch(`https://hn.algolia.com/api/v1/items/${hn[1]}`, { signal: AbortSignal.timeout(20_000) });
    if (!item.ok) throw new Error(`${item.status}`);
    const body = (await item.json()) as { text?: string };
    return (body.text ?? "").replace(/&#x2F;/g, "/").replace(/&#x40;|&#64;/g, "@");
  }
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
    },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.text()).slice(0, 3_000_000);
}

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
