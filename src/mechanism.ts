/**
 * Which mechanism produced a Worktree directory.
 *
 * `cow` is a Deep clone (extents shared with the source, ignored files
 * carried); `git` is a Shallow worktree produced by opencode2's built-in
 * strategy. The value is reported to the caller so an agent that relies on
 * ignored state knows whether it actually has it.
 */
export type Mechanism = "cow" | "git";
