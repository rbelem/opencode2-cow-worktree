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

const HOOKS = "hooks";

/**
 * Reads the post-create hooks from the plugin's free-form `options`, shaped
 * `hooks: { postCreate: string[] }`.
 *
 * Absent — the option, the `hooks` object, or the `postCreate` list — means no
 * hooks: a caller who did not ask for them gets exactly the create behavior
 * they had before. A value that is not an array of non-empty command strings
 * throws rather than being ignored: a misconfiguration must not silently skip
 * setup the user believes runs on every clone.
 */
export function postCreateHooks(
  options: Record<string, unknown> | undefined,
): readonly string[] {
  const hooks = options?.[HOOKS];
  if (hooks === undefined) return [];
  if (!isHooksObject(hooks)) {
    throw new Error(
      `invalid plugin option "${HOOKS}": expected an object with a "postCreate" command list, got ${JSON.stringify(hooks)}`,
    );
  }
  const commands = (hooks as { postCreate?: unknown }).postCreate;
  if (commands === undefined) return [];
  if (!isCommandList(commands)) {
    throw new Error(
      `invalid plugin option "${HOOKS}.postCreate": expected an array of non-empty command strings, got ${JSON.stringify(commands)}`,
    );
  }
  return commands;
}

function isHooksObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommandList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((command) => typeof command === "string" && command.trim() !== "")
  );
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
