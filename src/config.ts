import type { FallbackPolicy } from "./tool";

const ACCEPTED: readonly FallbackPolicy[] = ["none", "git"];

/**
 * Reads the fallback policy from the plugin's free-form `options`.
 *
 * Absent means disabled (`"none"`): the fallback is opt-in, so a caller who did
 * not ask for it never silently gets a Shallow worktree. An unrecognized value
 * throws rather than degrading to `"none"` — a misconfiguration must not change
 * the mechanism a caller gets without saying so.
 */
export function fallbackPolicy(
  options: Record<string, unknown> | undefined,
): FallbackPolicy {
  const value = options?.fallback;
  if (value === undefined) return "none";
  if (isFallbackPolicy(value)) return value;
  throw new Error(
    `invalid plugin option "fallback": expected one of ${ACCEPTED.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

function isFallbackPolicy(value: unknown): value is FallbackPolicy {
  return (ACCEPTED as readonly unknown[]).includes(value);
}
