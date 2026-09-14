# Refuse attach onto an occupied cow worktree, via a self-recorded session marker

**Status:** proposed (2026-09-14)

Reflink clones made parallel worktrees nearly free, which moved the cost of
isolation to zero and made sharing a directory the one case that must justify
itself. It cannot. `spawn_workspace`'s attach path (src/tool.ts
`attachToExisting`) checks provenance — the inventory says `cow`, `.git` is a
directory — but not occupancy, and it cannot consult opencode2 for liveness
because server plugins cannot enumerate sessions (ADR 0003). A second
`spawn_workspace` with the same name binds a fresh session into a directory a
live agent is mid-turn in: two writers, one path, each seeing the other's
writes within the turn.

The decision: **attach refuses a cow worktree a live session occupies.** The
tool records the fact itself, because it is the only party that knows it.

- At session start — both the create and attach flows — `spawn_workspace`
  writes `.cow-session.json` at the worktree root:
  `{ "sessionID", "startedAt" }`.
- At attach, a present marker is probed through `ctx.session.get`. An answer
  that positively resolves the session refuses the attach, naming the
  occupying session id and `startedAt`, with two recoveries in the message:
  pick another name, or remove the marker file when it is known stale.
  A definitive "no such session" marks the marker stale; attach proceeds and
  rewrites it. **Any other probe outcome fails the attach.** A false refusal
  costs one re-run or one `rm`; a false clearance is the silent
  concurrent-agent case this ADR exists to prevent.
- The create flow rewrites the marker after cloning, so a worktree cloned
  from another worktree never inherits a live marker as truth.
- The create flow also appends `.cow-session.json` to `.git/info/exclude`,
  idempotently, so the marker never appears in `git status` — `remove`'s
  uncommitted-changes probe and the lane absorb pre-checks stay clean.

This amends ADR 0003 narrowly, along the revisit trigger that ADR states for
itself: identity and listing keep deriving from the inventory with no
registry. Occupancy is a per-worktree fact the inventory does not carry, and
it records exactly one — the session this tool started — not a registry of
facts. When the upstream ask lands (`session.list` on the server-plugin
Context, candidate 5 in `docs/research/upstream-issues.md`), the marker and
its probe are deleted in favor of the inventory answer: migrate, then remove.

## Considered options

- **Upstream `session.list` first** (candidate 5): the clean fix and the
  marker's deletion path; rejected as the first move because it blocks on an
  external ask while the harm ships today.
- **Path-keyed registry beside the worktrees**: the full registry ADR 0003
  rejected — a second source of truth, locks, and a staleness surface, for
  one fact.
- **Write-churn / mtime heuristic**: not a fact. False-refuses quiet
  worktrees, false-clears busy ones.
- **Document-only**: the harm is silent mid-turn divergence between two
  agents; a doc line does not stop it, and the parallel caller's alternative
  (spawn a fresh lane, ~25 ms) makes refusal cost nothing.

## Consequences

- **Positive.** The tool's own flows can no longer silently place two agents
  in one directory. No daemon, no heartbeat, no lock file protocol: one
  marker file and one probe against an API that already exists. Stale
  markers heal on the next attach.
- **Negative.** One on-disk fact that can go stale — revising 0003's "no
  on-disk state that can go stale"; the probe is what makes staleness
  harmless instead of load-bearing. Sessions started outside
  `spawn_workspace` (a TUI session opened inside a cow worktree) remain
  invisible; the guard covers the tool's flows and is strictly no worse than
  today. A truly simultaneous attach pair can still interleave probe and
  session create; closing that race needs a lock, which is the machinery
  this ADR deliberately avoids. The realistic case — a sequential re-spawn
  onto a live worktree — is closed.
- **Verified fact still needed.** The running binary's `session.get`
  behavior for an absent id (throw vs absent-result) decides the
  fail-closed predicate's exact shape; the implementation issue probes it
  before wiring, and the `SessionDomain` augmentation in
  `types/opencode2-worktree.d.ts` grows a minimal structural `get` slice per
  that file's stated convention.
- **Non-goal.** Create-from-a-live-source stays unguarded: a clone snapshots
  the source at clone moment, and a source mid-turn yields a torn but
  git-valid tree. That is snapshot semantics, documented as the spawn-direction
  twin of the lane absorb rule ("terminal before touching"), not a mechanism.
