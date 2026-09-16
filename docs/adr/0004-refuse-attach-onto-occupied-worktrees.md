# Refuse attach onto an occupied cow worktree, via a self-recorded session marker

**Status:** accepted (2026-09-14)

Reflink clones made parallel worktrees nearly free, which moved the cost of
isolation to zero and made sharing a directory the one case that must justify
itself. It cannot. `spawn_workspace`'s attach path (src/tool.ts
`attachToExisting`) checks provenance — the inventory says `cow`, `.git` is a
directory — but not occupancy, and it cannot consult opencode2 for liveness
because server plugins cannot enumerate sessions (ADR 0003). A second
`spawn_workspace` with the same name binds a fresh session into a directory a
live agent is mid-turn in: two writers, one path, each seeing the other's
writes within the turn.

The decision: **attach refuses a cow worktree whose recorded session is live.**
The tool records the fact itself, because it is the only party that knows it.

- At session start — both the create and attach flows, and only for the `cow`
  mechanism (the git fallback's `.git` is a file; there is nothing to attach
  to and no exclude file to write) — `spawn_workspace` writes
  `.cow-session.json` at the worktree root: `{ "sessionID", "startedAt" }`.
  One helper owns the write and is idempotent: it first ensures the marker
  name sits in `.git/info/exclude`, then writes the file, so `git status`
  never observes the window between the two writes. A failed marker write
  never fails the call: the session already exists, so the result carries a
  warning instead ("this worktree is unguarded").
- At attach, a present marker is probed through the session API. The probe
  answers **existence plus freshness**, not liveness directly: sessions
  persist in storage after their work ends, and the `Session` record carries
  no status field (verified against the running binary,
  0.0.0-next-20260912.3). `time.updated` advances at message writes only, so
  the window measures silence since the last message write:

  | Marker | Probe result | Attach |
  |---|---|---|
  | absent | — | proceed (legacy worktree; today's behavior, fail-open), then marker written |
  | malformed (unparsable, empty id) | — | **refuse** (fail closed; same recoveries) |
  | present | 404, session absent or deleted | stale; proceed, rewrite marker |
  | present | 200, `time.updated` missing or not usable epoch-ms | **refuse** (fail closed; naive Infinity math would read dormant) |
  | present | 200, silent longer than the window | dormant; proceed, rewrite marker |
  | present | 200, message activity within the window | **refuse**, naming the session id, its last-active age, and the recoveries |
  | present | probe failure that is not a positive absence | **refuse** (fail closed) |

- Absence is classified only from a positive signal — a thrown error tagged
  `_tag: "SessionNotFoundError"`, or a probe result of `null`/`undefined`.
  Every other non-conforming shape — a non-object primitive, a body without a
  string `id`, a probe failure of any other kind — refuses; nothing that
  proves nothing about the session may clear its marker. A transient probe
  error must never masquerade as a 404 and clear a live session's marker.
- The window is 60 minutes. Derivation: updates land at message writes, so a
  turn that writes no message for longer than the window false-clears — and
  false clearance is the worse direction by this ADR's own asymmetry (a
  false refusal costs a new name, a session delete, or one `rm`; a false
  clearance is the bug itself). The constant is named, and the value is the
  generous end of plausible turn silence.
- The refusal message lists three recoveries: pick another worktree name;
  delete the occupying session out of band (`DELETE /api/session/<id>`,
  verified to return 204 and truly remove the record); or remove the marker
  file when it is known stale.
- The create flow rewrites the marker after cloning, so a worktree cloned
  from another worktree never inherits a live marker as truth. `startedAt`
  records the plugin host's clock and is informational; decisions never
  compare it against the server-side `time.updated`.

This amends ADR 0003 narrowly, along the revisit trigger that ADR states for
itself: identity and listing keep deriving from the inventory with no
registry. Occupancy is a per-worktree fact the inventory does not carry, and
it records exactly one — the session this tool started — not a registry of
facts. When the upstream ask lands (`session.list` on the server-plugin
Context, candidate 5 in `docs/research/upstream-issues.md`), the marker and
its probe are deleted in favor of the inventory answer: migrate, then remove.

## Verified facts (binary 0.0.0-next-20260912.3, probed 2026-09-14)

- `GET /api/session/<absent>` answers HTTP 404 with
  `_tag: "SessionNotFoundError"`; a deleted session answers 404 the same
  way. `DELETE /api/session/<id>` returns 204 and the subsequent read 404s.
  Existence and deletion are definitively classifiable.
- The `Session` record carries `time.created` / `time.updated` (epoch ms)
  and no status, running, or liveness field. A live probe of a completed sim
  turn saw exactly two distinct `time.updated` values — session create, then
  the turn's message writes — and a frozen value thereafter. The field
  tracks message writes, not per-part streaming; hence the freshness
  window's derivation above.
- `session.get` exists on the v2 server-plugin `Context` but the installed
  `@opencode-ai/plugin` beta types only `create`; the augmentation in
  `types/opencode2-worktree.d.ts` grows a minimal structural `get` slice
  (that file's stated convention). Verified at implementation time: the
  runtime call takes `{ sessionID }` — a bare string fails the input schema
  with `SchemaError: Expected object` — and an absent id throws tagged
  `_tag: "Session.NotFoundError"` with an empty message, while the HTTP
  payload spells the same 404 `SessionNotFoundError`. Both tags are pinned
  (unit and e2e); a substring message match is deliberately not a signal.

## Considered options

- **Upstream `session.list` first** (candidate 5): the clean fix and the
  marker's deletion path; rejected as the first move because it blocks on an
  external ask while the harm ships today.
- **Existence-only refusal** (get resolves → refuse): rejected — sessions
  persist after completion, so every legitimate re-attach to a finished
  worktree would refuse until a human removes the marker. The common path
  must not require a manual override.
- **Event-driven in-memory liveness** (subscribe to session events, keep a
  live set): the registry machinery ADR 0003 rejected, plus a server-restart
  blind spot, for marginal gain over a freshness window.
- **Atomic claim directory** (`mkdir`, EEXIST = concurrent claim) instead of
  a marker file: rejected — a claim artifact must still survive the dormant
  window to mean anything, which reintroduces the same staleness machinery
  for a race this ADR accepts instead.
- **Write-churn / mtime heuristic**: not a fact. False-refuses quiet
  worktrees, false-clears busy ones.
- **Document-only**: the harm is silent mid-turn divergence between two
  agents; a doc line does not stop it, and the parallel caller's alternative
  (spawn a fresh lane, ~25 ms) makes refusal cheap.

## Consequences

- **Positive.** The tool's own flows routinely prevent two agents in one
  directory within the freshness window. No daemon, no heartbeat, no lock
  file protocol: one marker file, one probe, one exclude line, one window.
  Stale and dormant markers heal on the next attach.
- **Negative.** One on-disk fact that can go stale — revising 0003's "no
  on-disk state that can go stale"; the probe is what makes staleness
  harmless instead of load-bearing. `spawn_workspace` stops being idempotent
  on name: a retried call refuses its own just-created session, and the
  refusal's occupying-id is how the caller detects that. A turn silent on
  the API past the window reads as dormant — accepted false clearance, the
  derivation above chose the window with that bias. After a dormant
  takeover, the old session record persists and can still be resumed in
  that directory; two writers, marker blind to the second. That is an
  expected shape of the lane-resume flow, not a corner case, and the
  refusal message's recoveries are the surface for it. Sessions started
  outside `spawn_workspace` (a TUI session opened inside a cow worktree)
  remain invisible; the guard covers the tool's flows and is strictly no
  worse than today. The uncovered race is not quantum simultaneity but any
  interleaving between one attach's probe and another's marker write; an
  atomic claim cannot close it without also surviving the dormant window,
  so it stays a documented residual. The dormant row is unit-tested only
  (aging a session in e2e would require storage surgery); no clock option
  is added to the tool to make it e2e-able.
- **Non-goal.** Create-from-a-live-source stays unguarded: a clone snapshots
  the source at clone moment, and a source mid-turn yields a torn but
  git-valid tree. That is snapshot semantics, documented as the spawn-direction
  twin of the lane absorb rule ("terminal before touching"), not a mechanism.
