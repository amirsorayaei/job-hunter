/**
 * The human sentence inside a Convex server error.
 *
 * A thrown `Error("…")` reaches the client as
 * `[CONVEX M(module:fn)] [Request ID: …] Server Error\nUncaught Error: <message>\n    at handler (…)`.
 * Toasts should show only `<message>`.
 */
export function friendlyError(error: unknown, fallback = "Something went wrong"): string {
  if (!(error instanceof Error)) return fallback;
  const match = /Uncaught Error:\s*([\s\S]*?)(?:\s+at\s+\S+\s*\(|$)/.exec(error.message);
  const text = (match?.[1] ?? error.message).trim();
  return text === "" ? fallback : text;
}
