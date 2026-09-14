# Changelog

## 0.1.0

The first prepared release cut. The package is still `private: true`; this
entry marks what a publish would ship.

- **`cow` Strategy**: Deep clones via forced reflink (Linux
  `COPYFILE_FICLONE_FORCE`, macOS `copyfile(3)` through `bun:ffi`), a fail-loud
  capability probe, and a same-device pre-flight. Refuses an occupied target
  before the first write, and a failed create removes only what it cloned.
- **`spawn_workspace`**: create-plus-session with attach-to-existing semantics
  (`attached: true`), `mechanism` reporting, an opt-in `git` fallback, and a
  loud refusal of anything at the target path the inventory does not know as a
  cow worktree.
- **`list_worktrees`**: the location's cow worktrees, derived from opencode2's
  inventory alone.
- **Post-create hooks** (`hooks.postCreate`): sequential `sh -c` in the new
  worktree, `COW_WORKTREE_PATH`/`COW_SOURCE_DIRECTORY` in the environment, a
  five-minute per-command timeout, stdin detached, captured output capped in
  errors, and a first failure that rolls the create back.
- **Removal**: an uncommitted-work guard that fails closed on unknown state, an
  identity-captured quarantine rename, and two-phase deletion with an async
  tail for `node_modules`.
- Every plugin option validated once at setup; misconfiguration fails the
  plugin load rather than surfacing mid-session.
- macOS backend verified on real APFS by CI (arm64 and x86_64, shared extents
  measured). A 31-scenario parallel-agent swarm and a four-scenario e2e
  harness are recorded under `docs/e2e/`.
- Development: `scripts/lane.ts` spawns and absorbs parallel CoW lane clones
  (origin-stripped, `--no-ff` absorb); conventions in `docs/lane-workflow.md`.
