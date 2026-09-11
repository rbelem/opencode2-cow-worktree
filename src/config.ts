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

const TARGET_ROOT = "targetRoot";

/**
 * Reads the Worktree target root from the plugin's free-form `options`.
 *
 * Absent means the tool picks a parent on the source's own filesystem (a sibling
 * of the source) — the same-device default a CoW clone requires. A configured
 * value is used verbatim, even when it names a different filesystem, because
 * that is precisely the case the tool must diagnose instead of hiding. A
 * non-string or empty value throws rather than degrading to the default: a
 * misconfiguration must not silently relocate every clone.
 */
export function targetRoot(
  options: Record<string, unknown> | undefined,
): string | undefined {
  const value = options?.[TARGET_ROOT];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new Error(
    `invalid plugin option "${TARGET_ROOT}": expected a non-empty path string, got ${JSON.stringify(value)}`,
  );
}
