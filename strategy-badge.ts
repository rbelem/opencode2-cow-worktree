/**
 * The badge decision for a worktree inventory, kept a pure function so it can
 * be tested without a TUI or a live server.
 *
 * Returns the literal `"cow"` only when an entry's `directory` matches exactly
 * and that entry's `strategy` is opencode2's `cow` strategy id. Everything else
 * — no match, an empty inventory, a `git` entry, an entry with no strategy —
 * yields `undefined`, which the caller renders as nothing.
 */

/** The slice of a worktree inventory entry the badge decision reads. */
export interface WorktreeEntry {
  readonly directory: string;
  readonly strategy?: string;
}

export function strategyBadge(
  entries: readonly WorktreeEntry[],
  directory: string,
): "cow" | undefined {
  const match = entries.find((entry) => entry.directory === directory);
  return match?.strategy === "cow" ? "cow" : undefined;
}
