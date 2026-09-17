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

# 14: Desktop hardcodes `strategy: "git"` — RESOLVED upstream

**Problem (historical).** `packages/app/src/workspaces/create.ts` sent
`strategy: "git"` unconditionally to `POST /api/worktree`, defeating the
location's selected strategy. The TUI equivalent was fixed in PR #47991
(merged 2026-09-08); App/Desktop was not included. Full trace in
`docs/research/desktop-strategy-hardcode.md`.

**Resolution (2026-09-17).** Fixed upstream by the projectID refactor: the
helper on the v2 tip now sends `{ projectID, from, branch }` and no strategy
literal, and `Worktree.CreateInput` no longer declares a `strategy` field at
all — core resolves the create through the selected strategy
(`getStrategy(settings.selected, …)` in `packages/core/src/worktree.ts`).
Filed as rbelem/opencode2-cow-worktree#14; closed against this evidence.

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

## 6. Nightly 20260915: `/api/health` answers 404 with auth; 20260917 also drops `await-activation`

**Problem.** Observed 2026-09-16 against `0.0.0.0-next-20260915` (devbox
profile). The server boots and serves every endpoint the plugin and e2e use,
but `GET /api/health` returns 404 with auth and 401 without — the auth guard
fires on every `/api/*` path, so the 401 says nothing about route existence
and the authenticated 404 means no handler is registered. On the pinned
`0.0.0-next-20260912.3` the same route answers 200. Re-verified
2026-09-17 against `0.0.0-next-20260917`: `/api/health` is still gone, and
`POST /api/plugin/await-activation` now answers 404 too — plugin activation
is observable only through `GET /api/plugin`, whose list shows the plugin
`active` once the loader finishes.

**Workaround status.** The e2e readiness probe (`scripts/e2e/server.ts`)
polls `GET /api/plugin`, and `waitForPlugin` treats the `await-activation`
404 as "route gone" while still detecting activation through the plugin
list. The plugin itself never calls either route.

**File it if** upstream confirms the move was unintentional (the protocol in
the 2026-08-13 clone still declares `/api/health` at
`packages/protocol/src/groups/health.ts`). Recommended: **low effort, ask
first** — one-line question upstream: "did `/api/health` move or regress on
the 20260915 nightly?"

## 7. Nightly 20260915: worktree create demands `projectID`; the plugin path breaks — ADAPTED plugin-side

**Problem.** Same nightly. `POST /api/worktree` rejects a payload without
`projectID` (`InvalidRequestError: Missing key at ["projectID"]`), and the
in-process plugin path fails identically. The 20260917 nightly keeps the
requirement and extends it to every worktree endpoint (list, remove,
refresh), drops the `strategy` request field entirely, and suffixes
`name-2 … name-10` when the assembled `<parent>/<name>` already exists
(`packages/core/src/worktree.ts`, verified against the v2 tip).

**Workaround status.** Shipped in 0.3.0: the plugin derives `projectID` from
`ctx.location.project.id` on every worktree call, passes the source as
`from` (the old `location` key is gone), and still sends `strategy` for
2.0.2-era binaries, where the field selects the git fallback's mechanism.
Consequence recorded under the fallback option in the README: on
projectID-era binaries the git fallback cannot be requested and a non-CoW
source fails with the cow refusal.

**File it if** the projectID requirement survives into a release build: then
the plugin must grow the field (with a fallback for binaries that ignore it),
or every plugin-created worktree dies. Recommended: **high value if it
survives**, since it gates the plugin's core verb.

---

## 8. `Worktree.remove` resolves the real path before reading the record, so a gone directory can never be cleared

**Problem.** `DELETE /api/worktree` on a worktree whose directory no longer
exists answers 400 `Worktree directory unavailable` (`forceRequired: null`),
even at `force: true`. `Worktree.remove` (`packages/core/src/worktree.ts`)
runs the realpath/resolve step *before* `ops.find`, so the missing-directory
error fires before the recorded strategy is consulted and `force` never
reaches a path that could ignore it. Measured against the pinned
`0.0.0-next-20260912.3` and re-verified against the v2 tip
(`0.0.0-next-20260917`, where the op also takes `projectID`); filed as
rbelem/opencode2-cow-worktree#12 with the full repro.

**Workaround status.** Plugin-side half shipped in v0.1.0: `cow.remove`
resolves a vanished directory as an already-complete removal, covering the
race window. The API path itself is out of plugin reach.

**File it if** users should be able to clear a dangling worktree row through
the API (anyone who `rm -rf`s a worktree, or whose volume unmounted, currently
edits `opencode.db` by hand). Proposed fix: read the record first; treat a
missing directory as nothing to delete on disk, gated on `force`. Recommended:
**ride the announcement batch** — it is the cleanup half of the same story as
candidate 1.

---

## Suggested filing batch (when the owner decides)

1. Server-plugin session listing (candidate 5) — small, high-leverage SDK ask.
2. `Worktree.remove` realpath-first (candidate 8) — clears dangling rows.
3. Optional riders: strategy post-create hook (4), `instanceof` fix (2).
4. Nightly candidates 6 — ask-first (health and await-activation routes).

Candidate 1 (Desktop hardcode) resolved itself in the projectID refactor;
candidate 7 is adapted plugin-side (0.3.0).
