/**
 * The decision half of `cow`'s `remove`, kept pure — in the style of
 * `entry-kind.ts` — so the refusal table can be tested without a filesystem or
 * a git repository.
 *
 * opencode2's `force` means "proceed despite uncommitted changes", which is not
 * `node:fs` `rm`'s `force` ("ignore a nonexistent path"). The built-in `git`
 * strategy maps it to `git worktree remove --force` and refuses when the
 * worktree is dirty; `cow` must refuse at `force: false` for the same reason,
 * or it silently deletes uncommitted work.
 *
 * A probe that cannot answer (no git metadata, a failing or timed-out `git`, a
 * machine without git) yields `undefined`, which is deliberately treated as
 * dirty: deleting on an unknown is the data loss this guards against.
 */

/** The changed paths the probe found, or `undefined` when it could not tell. */
export type UncommittedChanges = readonly string[] | undefined;

/** Whether `remove` may proceed, and why not when it may not. */
export type RemoveDecision =
  | { readonly remove: true }
  | { readonly remove: false; readonly reason: string };

/** How many changed paths the refusal names as examples. */
const EXAMPLE_PATHS = 3;

/**
 * Decides whether `remove` may delete a directory.
 *
 * `force: true` is the user's confirmation and always allows removal.
 * Otherwise a non-empty change list refuses, and so does `undefined` — an
 * unknown dirty state is never safe to delete. Only a probe that positively
 * reported no changes allows removal.
 */
export function mayRemove(input: {
  readonly force: boolean;
  readonly uncommitted: UncommittedChanges;
}): RemoveDecision {
  if (input.force) return { remove: true };
  if (input.uncommitted === undefined) {
    return {
      remove: false,
      reason:
        "its uncommitted changes could not be determined (no git metadata, or the git probe failed)",
    };
  }
  if (input.uncommitted.length === 0) return { remove: true };
  const examples = input.uncommitted.slice(0, EXAMPLE_PATHS).join(", ");
  return {
    remove: false,
    reason: `${input.uncommitted.length} uncommitted change(s) (e.g. ${examples})`,
  };
}
