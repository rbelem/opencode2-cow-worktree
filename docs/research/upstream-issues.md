# Upstream issues — candidates, workarounds, and a filing decision

**Status:** deliberately **not filed** (decision 2026-09-13). This memo exists
so the owner can read it later and decide what deserves an upstream issue at
`github.com/anomalyco/opencode` (public, MIT, contributions target branch
`v2`; bug-fix PRs must reference an issue). Facts below were verified against
the build-exact upstream source at rev `7c5a4d01aa2a8144a81b6261aad220cf5a84c107`
(v2.0.2) unless noted.

**Working rule adopted instead of filing:** build plugin-side workarounds
where possible; document the rest. Verdicts per candidate below.

---

## 1. Desktop hardcodes `strategy: "git"` — plugin strategies unreachable from the Desktop UI

**Problem.** `packages/app/src/workspaces/create.ts:14` sends
`strategy: "git"` unconditionally to `POST /api/worktree`, defeating the
location's selected strategy, so installing (and selecting) `cow` changes
nothing in the Desktop "new worktree" UI. The TUI equivalent was fixed in PR
#47991 (merged 2026-09-08) by deleting the same override; App/Desktop was not
included.

**Evidence.** Full trace in `docs/research/desktop-strategy-hardcode.md`:
introduced with the helper's first commit (`96d8462`, PR #45735) before
plugin strategies existed; knowingly retained in PR #47358; left behind by
the TUI fix. The literal is still present on the public `v2` tip.

**Workaround status.** None. The only plugin-side seam that reaches the
Desktop path (registering a strategy whose id hijacks `"git"`) is unsafe and
was rejected in this repo's own analysis.

**File it if** Desktop usage of `cow` matters. Recommended: **file when
announcing the plugin** — it is the single blocker for Desktop adoption, the
fix is a one-line deletion with an exact in-repo precedent (#47991), and the
write-up is already done.

## 2. `Worktree.OperationError` `instanceof` broken for installed plugins; `forceRequired: null`

**Problem.** The server wraps strategy errors in `Worktree.OperationError`
(`packages/core/src/worktree.ts:374`), but `instanceof` checks in the handler
(`packages/server/src/handlers/worktree.ts:38-41`) fail for code loaded from
an installed plugin (different module instance across the bundle boundary), so
structured fields degrade — observed as `forceRequired: null` in refusal
responses (documented in `docs/e2e/findings.md` #14).

**Workaround status.** Done at `dcc8ce1`: the plugin raises plain `Error`
with the guard's message text instead of relying on the structured error
path; `forceRequired: null` remains a cosmetic upstream wrapper artifact.

**File it if** structured worktree errors should work for plugin strategies
at all. Recommended: **low priority** — behavior is correct via the
workaround; file only alongside another plugin-SDK issue so the ask
("structural `_tag` checks instead of `instanceof`") rides a real use case.

## 3. Worktree registry / attach pattern — plugin-local by design

**Problem (upstream-shaped).** Nothing is broken upstream. ADR 0003 records
the plugin-side decision: derive listing/attach data from the upstream
inventory instead of a plugin-owned registry. The attach pattern (re-calling
create with an existing name) is implemented plugin-side in this iteration.

**File it.** **No.** Nothing to ask for. If upstream ever grows a first-class
worktree registry or name-collision policy for `POST /api/worktree`, revisit
ADR 0003 and the attach branch.

## 4. No `post-create` hook point in the worktree-strategy interface

**Problem.** Strategies materialize a worktree but get no hook to provision
it afterwards (deep clones ship stale `node_modules` and lack regenerated
ignored state; users may want `post-create` commands). workmux solves this
with `post_create`/`pre_remove` hook groups run in the worktree with
structured env. A plugin can approximate this inside its own tool flow, but a
hook **in the strategy interface** would benefit every strategy, not just
`cow`.

**Workaround status.** None built yet; deferred tier (ticket tier C). A
plugin-local `post_create` for `spawn_workspace`-created worktrees is
possible without upstream.

**File it if** upstream is receptive to interface extension. Recommended:
**medium** — a focused feature ask ("let strategies declare post-create
steps, run after materialization, fail-loud") with the deep-clone staleness
story as motivation. Pair it with candidate 5 if filing a small plugin-SDK
batch.

## 5. Server-plugin `Context` cannot enumerate sessions

**Problem.** `Context.session` exposes create/get/rename/etc. but **no
`list`** (`packages/plugin/src/promise/session.ts:112-129`; runtime wiring
`adapter.ts:574-587`), while the raw client API has
`GET /api/session` with `directory`/`workspace`/`search` filters
(`packages/client/src/promise/generated/client.ts:521-543`). Only the **TUI**
plugin context exposes a full client (`packages/plugin/src/tui/context.ts:508`),
which is why `tui.tsx` can call `client.worktree.list` but a server-side tool
cannot answer "which sessions live in this worktree".

**Workaround status.** Accepted gap: `list_worktrees` ships without a
sessions field (ADR 0003 consequence, recorded in ticket 02).

**File it if** agents should discover sessions bound to a worktree (the
natural swarm question "who is working where?"). Recommended: **medium-high**
value, tiny ask — "expose `session.list` (or a read-only client handle) on
the server-plugin Context, mirroring the TUI context". This is the one new
candidate produced by the attach/list design work.

---

## 6. Nightly 20260915: `/api/health` answers 404 with auth

**Problem.** Observed 2026-09-16 against `0.0.0.0-next-20260915` (devbox
profile). The server boots and serves every endpoint the plugin and e2e use,
but `GET /api/health` returns 404 with auth and 401 without — the auth guard
fires on every `/api/*` path, so the 401 says nothing about route existence
and the authenticated 404 means no handler is registered. On the pinned
`0.0.0-next-20260912.3` the same route answers 200.

**Workaround status.** The e2e readiness probe (`scripts/e2e/server.ts`
`waitForHealth`) polls `GET /api/plugin`, which both binaries serve, and
comments the why in place.

**File it if** upstream confirms the move was unintentional (the protocol in
the 2026-08-13 clone still declares `/api/health` at
`packages/protocol/src/groups/health.ts`). Recommended: **low effort, ask
first** — one-line question upstream: "did `/api/health` move or regress on
the 20260915 nightly?"

## 7. Nightly 20260915: worktree create demands `projectID`; the plugin path breaks

**Problem.** Same nightly. `POST /api/worktree` rejects a payload without
`projectID` (`InvalidRequestError: Missing key at ["projectID"]`), and the
in-process plugin path fails identically: `ctx.worktree.create` passes
`strategy`/`name`/`location`/`directory` per the pinned contract, so
`spawn_workspace` errors on every create — cow and git strategies alike —
meaning the plugin cannot create any worktree on the nightly. The project id
is discoverable (`GET /api/project?location[directory]=…` returns it; it
resolved to `"global"` on the scratch roots).

**Workaround status.** None shipped. The e2e fan-out passes `projectID`
discovered from `GET /api/project`; the plugin still speaks the pinned
contract. An adaptation (pass `ctx.location.project.id`) is possible but
chases a nightly and risks the pinned binary if it rejects unknown keys —
hence this entry instead of a commit.

**File it if** the projectID requirement survives into a release build: then
the plugin must grow the field (with a fallback for binaries that ignore it),
or every plugin-created worktree dies. Recommended: **high value if it
survives**, since it gates the plugin's core verb.

---

## Suggested filing batch (when the owner decides)

1. Desktop hardcode (candidate 1) — blocks adoption; write-up ready.
2. Server-plugin session listing (candidate 5) — small, high-leverage SDK ask.
3. Optional riders: strategy post-create hook (4), `instanceof` fix (2).
4. Nightly candidates 6-7 — ask-first; candidate 7 gates the plugin's core
   verb if it survives into a release.
