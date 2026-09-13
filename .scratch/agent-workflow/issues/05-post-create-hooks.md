# 05: Post-create hooks (tier C)

**What to build:** a plugin option `hooks: { postCreate: string[] }` —
validated fail-loud exactly like `fallback`/`targetRoot` (array of non-empty
strings; absent/empty = zero behavior change). After a CoW worktree
materializes, at the end of the strategy's create flow — so every entry path
(API, TUI, `spawn_workspace`) gets it — each command runs sequentially via
`sh -c`, cwd = the new worktree, with `COW_WORKTREE_PATH` and
`COW_SOURCE_DIRECTORY` (absolute) in the environment and output captured for
error context. First failure aborts creation: the just-created worktree is
removed (no orphan clone — same contract as the existing failed-session
rollback) and the error names the failed command and its 1-based step number.
Per-command timeout as a named constant in the house `GIT_TIMEOUT_MS` style.
Attach never runs hooks. Commands needing per-project values can read them
from env; document that per-project option values already come free by
setting the plugin's `options` in a project-level `opencode.json` (document;
do not build a new config file).

**Work happens in the provided CoW clone; commit on branch `lane-c`. Never
push, fetch, or touch the origin remote.**

**Blocked by:** None (can start immediately). Independent of ticket 04
(remove-path hardening) — the only shared file is `src/strategy.ts`
(create tail here, remove internals there) and the merge is reconciled
upstream of you.

**Status:** ready-for-agent

- [x] Option validation fail-loud (non-array, non-string entries, empty
      strings), matching the existing option-error wording style
- [x] Hooks run sequentially, cwd=worktree, env injected, output captured;
      success passes silently
- [x] First failure: names command + step, removes the created worktree,
      error propagates; no orphan directory
- [x] No hooks configured → byte-identical create behavior (pinned)
- [x] Attach never runs hooks (pinned)
- [x] Timeout constant documented; timeout counts as failure with cleanup
- [x] Unit-covered to the repo gate (100% lines + functions); typecheck clean
- [x] e2e harness scenario: hook writes a marker → present after create;
      failing hook → create errors, directory gone (written and run locally
      against your own clone's server if feasible)
- [x] README: hooks section + per-project-options note
- [x] Committed on `lane-c` in the provided clone
