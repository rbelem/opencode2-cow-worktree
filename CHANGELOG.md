# Changelog

## 0.2.0

`spawn_workspace` refuses to attach a new session onto a cow worktree a live
session is still using (ADR 0004). The tool records occupancy itself: on both
the create and attach flows it writes `.cow-session.json` at the worktree root
(kept out of `git status` through `.git/info/exclude`), and at attach time it
probes the recorded session through the session API. Only a positive proof
that the session is gone lets attach proceed: a 404, or silence past a
60-minute window. A live session, a malformed marker, or a probe failure that
proves nothing refuses the attach and names the occupying session plus the
three recoveries (pick another name, delete the session out of band, remove a
known-stale marker). Legacy worktrees without a marker keep today's fail-open
behavior and gain a marker; the git fallback is untouched. A failed marker
write never fails the call; the result carries an "unguarded" warning.

Verified against a real `opencode2 serve` (`0.0.0-next-20260912.3`): the
attach scenario refuses on a live session, proceeds after the occupying
session is deleted, and backfills markers onto legacy worktrees
(`docs/e2e/run-2026-09-16.md`). Unit suite: 307 tests, coverage gate at 100%
lines on all 21 shipped files.

Also in this release:

- The e2e harness stays runnable across the 20260915 nightly split; its
  readiness probe polls `/api/plugin` because the nightly answers 404 on
  `/api/health`. The pinned `0.0.0-next-20260912.3` is unaffected.
- Docs: ADR 0004, the announcement draft, the ecosystem listing draft, and
  upstream filing candidates 6-8 (the nightly's `/api/health` 404, its
  `projectID` requirement that breaks plugin worktree creates, and the
  realpath-first `Worktree.remove` that strands dangling rows).

## 0.1.1

Documentation-only release; no code changes. It carries the new install
story to the npm package page: the plugin installs as a single config entry
(`opencode2` downloads it from npm at startup) or one
`opencode2 plugin add` command, with options in the same entry and the
checkout recipe kept for development. Also new: user-side verification with
`opencode2 plugin list`, the plugin-cache reset for stuck updates, the
recorded release procedure, and the ecosystem listing draft.

## 0.1.0

The first release: tagged `v0.1.0` and published to npm.

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
