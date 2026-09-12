# Desktop cannot select a plugin worktree strategy — the `strategy: "git"` hardcode

**Scope:** the build-exact source at `/nix/store/irlclfmhhwsdbww5m1i13nm41xpaifcd-source` (rev `7c5a4d01aa2a8144a81b6261aad220cf5a84c107`, "sync release versions for v2.0.2"), cross-checked against the public upstream `github.com/anomalyco/opencode` branch `v2` (tip `c82340a97b2d8a401919ccf28d30589ddcff0397` at time of writing). The hardcoded literal is present in both.

---

## Summary

`packages/app/src/workspaces/create.ts:14` unconditionally sends `strategy: "git"` to `POST /api/worktree`. Because the server's worktree service resolves the strategy as `input.strategy ?? current.selected` (`packages/core/src/worktree.ts:236`), the explicit literal defeats the location's selected strategy — which is exactly what `ctx.worktree.transform(editor => editor.add(...))` sets. So on Desktop, installing the `cow` plugin registers and *selects* `cow`, but the app's own "new worktree" UI still asks for `git`.

The literal was not an anti-plugin guard. It shipped with the helper's first commit (PR #45735, 2026-08-27), before plugin strategies existed. The plugin-strategy feature (PR #47358, merged 2026-09-04) knowingly left App/Desktop on explicit `git`; its own docs say adding a strategy selects it and "no strategy-selection config is needed" (`services/www/src/docs/content/build/plugins/index.mdx:994`). Then the *TUI equivalent* was fixed (PR #47991, merged 2026-09-08) by deleting the same override. App/Desktop was simply not updated. There is a clean, one-line upstream fix and an exact precedent for it.

**Bottom line:** legacy leftover, knowingly retained once, now an inconsistency/bug. Recommended fix: delete line 14 and update one test assertion. There is **no supported plugin-side workaround** for the Desktop UI path; the only seam that reaches it (`"git"` id hijack) is unsafe and already rejected in this repo's own analysis.

---

## Q1 — Why is `strategy: "git"` hardcoded: deliberate, oversight, or placeholder?

**Introduced with the file, before plugin strategies existed — not a deliberate plugin guard.**

- The helper was added in `96d84626f861e29cbf85be6ea3cf5ec1bc8e9b50` (PR #45735, "fix(core): keep project labels stable across clones", 2026-08-27). The added file already contained `strategy: "git"` alongside `projectID`, `from`, `branch`, `directory`. Commit: <https://github.com/anomalyco/opencode/commit/96d84626f861e29cbf85be6ea3cf5ec1bc8e9b50>.
- At that time there was no plugin strategy registration; the worktree API took `projectID` and a strategy. Passing `"git"` was just wiring the app to the only strategy.
- The feature that makes it wrong — `ctx.worktree.transform` + location-scoped strategy selection — landed later in `c30285c14880fa0208cb1a845ce71e26f76d1ffb` (PR #47358, 2026-09-04). That commit changed `create.ts` by **one line** (`projectID` → `location`); the `strategy: "git"` line is unchanged context. Commit: <https://github.com/anomalyco/opencode/commit/c30285c14880fa0208cb1a845ce71e26f76d1ffb>.
- It was **knowingly retained**, not missed by accident. The PR #47358 description states: *"TUI callers pass the source location and use server defaults instead of hardcoding Git and destination paths. App/Desktop callers also pass explicit locations, retaining Git/source-ref selection and the server-selected destination introduced by #47370."* (<https://github.com/anomalyco/opencode/pull/47358>). So at merge time this was a documented retention.
- It became an inconsistency four days later. PR #47991, "fix(tui): honor configured worktree strategy" (merged 2026-09-08), removed the identical override from the TUI, with rationale: *"The project worktree picker currently submits `strategy: "git"` and an internal destination, bypassing any worktree strategy registered by a plugin. Omitting those overrides lets the location-scoped worktree service apply its selected strategy and configured directory."* (<https://github.com/anomalyco/opencode/pull/47991>). The App/Desktop path was not included.
- The literal is still present on the public `v2` tip today: <https://raw.githubusercontent.com/anomalyco/opencode/v2/packages/app/src/workspaces/create.ts>. The path's full commit history on `v2` is only five commits, none of which post-date the scope-migration refactor `a5312e169b13` (2026-09-07); no App/Desktop fix followed the TUI fix.

**Classification (evidence-backed):** originally incidental/placeholder wiring → deliberately retained in #47358 → now an unaddressed bug that makes the #47358 feature unreachable from Desktop.

---

## Q2 — Does Desktop surface a strategy *choice* anywhere? How does `strategy` flow?

**No strategy choice exists anywhere in the app/desktop UI.** Verified by grepping `packages/app/src` and `packages/desktop` for `strategy`: the only occurrences are (a) the hardcoded literal in `create.ts`, (b) `workspaces/paths.ts` and `session`/workspace controllers using `strategy !== undefined` purely to *count/identify managed worktrees*, and (c) test fixtures. There is no settings field, dropdown, plugin-option surface, or config key for it.

- `packages/app/src/workspaces/paths.ts:15-19` — `managedWorkspaceDirectories` filters `worktree.strategy !== undefined`. Read-only.
- `packages/app/src/new-session/workspace/controller.ts:101-107` — `managedWorktrees` counts entries with a defined strategy. Read-only.
- Settings expose workspace *destination* only: `defaultDestination: Schema.Literals(["last-used","local","new"])` (`packages/app/src/settings/model.tsx:113-114`) → UI at `settings/general/general.tsx:75-93`. No strategy.
- Config schema has no strategy field: `packages/schema/src/config/worktree.ts:5-9` is `{ directory }` only.
- `packages/desktop/package.json:39` depends on `@opencode/app` (`workspace:*`); the desktop shell has **zero** references to `worktree`/`strategy` outside an unrelated SSH comment. Desktop consumes the shared app UI, so it inherits the same single call site.

**Flow from the call site to the server:**

1. Desktop "new worktree" UI sets the composer workspace selection to `"create"`; both flows route through `createWorktree`:
   - `packages/app/src/new-session/composer-adapter.ts:206-214` (`resolveSessionDirectory`, when `worktree === "create"`).
   - `packages/app/src/session/timeline/session-workspace-menu.tsx:56-64` ("move session to new worktree").
2. `createWorktree` calls `input.api.worktree.create({ location, strategy: "git", from: project.canonical, branch })` (`packages/app/src/workspaces/create.ts:12-17`).
3. Wire contract: `POST /api/worktree`, payload `Worktree.CreateInput` where `strategy` is **optional** (`packages/schema/src/worktree.ts:11-20`; endpoint at `packages/protocol/src/groups/worktree.ts:37-51`). Its own OpenAPI description says "Create a local worktree **using the location's registered strategy** and directory defaults".
4. Server handler forwards the payload untouched: `packages/server/src/handlers/worktree.ts:12` → `worktrees.create(ctx.payload)`.
5. Core resolution: `const selected = yield* getStrategy(input.strategy ?? current.selected, current.strategies)` (`packages/core/src/worktree.ts:236`). Explicit `"git"` wins; otherwise `selected`.
6. `selected` is initialized to the built-in git id (`packages/core/src/worktree.ts:146-147`) and **reassigned on every `add`** (`packages/core/src/worktree.ts:153-156`: `value.strategies.set(strategy.id, strategy); value.selected = strategy.id`). Docs: "Adding a strategy selects it automatically. The last active registration wins; no strategy-selection config is needed." (`plugins/index.mdx:994`).
7. The created worktree is recorded with `strategy: selected.id` (`packages/core/src/worktree.ts:260`), which is why a `cow` worktree would surface correctly in the app's `strategy`-filtered inventory if the default were used.

There is no client/API way to read the *currently selected* strategy; `GET /api/worktree` returns inventory entries `{ directory, strategy? }` (`packages/schema/src/worktree.ts:34-37`), not the selection.

---

## Q3 — Correct upstream fix

**Smallest correct patch: delete the literal and let the server default apply.**

In `packages/app/src/workspaces/create.ts`, remove the `strategy: "git",` line (line 14). The call then sends `{ location, from, branch }`; the server resolves `input.strategy ?? current.selected` (`core/src/worktree.ts:236`), i.e. the plugin's registered strategy when one is active, else built-in git. This is exactly the fix PR #47991 applied to the TUI (`packages/tui/src/component/dialog-open.tsx`, 2-line deletion: `strategy: "git"` and an internal `directory` override), whose rationale is quoted in Q1.

Why the alternatives are worse:

- **Make it configurable (client-side strategy choice):** the config schema intentionally has only `directory` (`packages/schema/src/config/worktree.ts`), and the design is explicit that registration selects the strategy with no selection config (`plugins/index.mdx:994`). Adding a selection knob is a product/feature change — per `CONTRIBUTING.md:12,82`, UI/core features require maintainer design review before implementation. Larger and unlikely to be wanted.
- **Read the plugin's declared strategy from the client:** not possible today — there is no "selected strategy" endpoint. `create` docs do say a caller *may* pass an explicit override for one call (`plugins/index.mdx:1013`), but the app has no reason to.

**Upstream tests that change:** only `packages/app/src/workspaces/create.test.ts`. Its POST-body assertion at lines 62-66 currently includes `strategy: "git"`; after the fix it becomes `{ from: input.canonical, branch: "clone-only" }`. No server/core/protocol test encodes the app's override.

Precedent for the shape of the patch (TUI): <https://github.com/anomalyco/opencode/pull/47991/files> — 2 source lines deleted, 5 test-expectation lines collapsed to 1.

---

## Q4 — Plugin-side workaround today? Seam-by-seam

**Conclusion: no safe, supported workaround for the Desktop UI path.**

| Seam | Works for Desktop? | Evidence |
|---|---|---|
| Register a strategy under id `"git"` (id hijack) | **Technically yes, but unsafe — No** | Core `add` does `strategies.delete(strategy.id); strategies.set(strategy.id, strategy); selected = strategy.id` with **no guard** against `"git"` (`packages/core/src/worktree.ts:153-156`). So a plugin *can* replace the built-in, and Desktop's explicit `"git"` would then hit the plugin. But this hijacks the built-in for the whole location: any pre-existing git worktree whose stored strategy is `"git"` would be removed via the hijacker's `remove` (`core/src/worktree.ts:291-303`), i.e. the CoW strategy's `rm -rf`, and `list`/`refresh` would lose git inventory. This repo already evaluated and rejected it: "Registering a definition with id `"git"` would hijack the built-in for the Location and mis-route removals … so it is not a workaround worth taking" (`docs/e2e/findings.md:308-311`). **Desktop does not change that safety evaluation** — it only means Desktop's explicit literal is the one caller a hijack would reach. |
| Config / env | **No** | `worktree` config schema is `{ directory }` only (`packages/schema/src/config/worktree.ts:5-9`). `OPENCODE_WORKTREE_BASE`/`OPENCODE_WORKTREE_PATH` are **outputs** passed to the project setup script, not strategy inputs (`packages/core/src/worktree.ts:278-279`). |
| Worktree hooks | **No** | Hooks are session/permission/shell/tool only (`plugins/index.mdx:1153-1509`). No `worktree.hook`; grep across `packages/plugin` finds none. The worktree domain exposes only `create/remove/list/refresh` + `transform`/`reload` (`packages/plugin/src/promise/worktree.ts:20-23`). |
| Server-side strategy resolution | **No** | This is the normal path the literal bypasses: resolution is `input.strategy ?? current.selected` (`core/src/worktree.ts:236`). A plugin already controls `current.selected` via `add`; it cannot intercept the inbound HTTP payload or override an explicit strategy through the public API. |
| Agent tool (`spawn_workspace`) | **Yes, but not the Desktop UI** | The plugin's tool passes `strategy` explicitly and calls the server directly (`src/plugin.ts:73-79`); the tool is unaffected by the app hardcode. But it is agent-facing, not the Desktop "new worktree" button, and it is not a general fix. |

Note on the repo's prior analysis: `docs/e2e/findings.md:309-310` says hijack would "mis-route removals of the project checkout (discovery records `strategy:"git"` for that path)". This specific detail does not match current code: `refresh` records `strategy: undefined` for the checkout root and only assigns a strategy id to non-root worktrees (`core/src/worktree.ts:330`; git `list` labels main as `"root"` at `core/src/worktree/git.ts:33`). The real hazard is pre-existing **non-root** git worktrees, as described above. The overall "don't hijack" conclusion stands.

---

## Q5 — Is upstream public and accepting contributions? Existing issue?

- **Repo / URL:** `github.com/anomalyco/opencode`, public, not a fork, not archived, MIT license (`LICENSE:1-3`; API `license.spdx_id: MIT`). Default branch `dev`, but contributions target **`v2`** (`CONTRIBUTING.md:84`).
- **Accepts contributions:** yes. "The changes most likely to be accepted are: Bug fixes …" (`CONTRIBUTING.md:3-6`). Constraints relevant here:
  - Bug fixes **must reference an existing issue** (`CONTRIBUTING.md:80`): use `Fixes #123` / `Closes #123`.
  - Feature requests require design approval before an implementation PR (`CONTRIBUTING.md:82`) — another reason to take the *bug-fix* framing (mirror #47991), not "add a strategy setting".
  - Conventional titles `type(scope): summary` (`CONTRIBUTING.md:100`), e.g. `fix(app): honor configured worktree strategy`.
  - Base the PR on `v2` and use the PR template (`CONTRIBUTING.md:84`).
- **Existing issue about the hardcoded strategy:** **none found.** GitHub issue/PR searches for `worktree strategy`, `honor worktree strategy`, `createWorktree`, and the literal `strategy: "git"` in `repo:anomalyco/opencode` surfaced only:
  - PR #47358 (the feature that left App/Desktop explicit),
  - PR #47991 (the TUI fix),
  - and no issue or PR for the App/Desktop call site.
  Marked **unverified as an exhaustive result** — GitHub search indexing is not a proof of absence. The directly analogous TUI change is #47991; the plugin repo tracks the gap as its own issues #12/#14 (`docs/e2e/findings.md:298-311`), which are not upstream.

---

## Q6 — Does Desktop actually use worktrees, or is this theoretical?

**Real, not theoretical.** Desktop is the Electron shell over the shared `@opencode/app` UI (`packages/desktop/package.json:39`), and two user-visible Desktop flows create worktrees through the hardcoded helper:

1. **New session → workspace picker → "Create new worktree"** (`packages/app/src/new-session/workspace/selector.tsx:152` "create" item; `controller.ts:200-204`; `composer-adapter.ts:206-214`).
2. **Session workspace menu → move to new worktree** (`packages/app/src/session/timeline/session-workspace-menu.tsx:56-64`).

With the hardcode, Desktop always asks for `git`, so it gets a standard `git worktree`: tracked files only, no ignored state. **A Desktop user loses the entire value proposition of this plugin via the built-in UI**: `node_modules`, build caches, and local env files are absent from each new workspace, even though the `cow` strategy is registered and selected on the server. The agent-facing `spawn_workspace` tool still produces CoW clones (it requests `cow` explicitly at `src/plugin.ts:73-79`), so the loss is specific to the Desktop-native flows — and notably the [new-session selector offers no signal](docs/e2e/findings.md §14) that the two mechanisms differ.

---

## What we can do now vs what needs upstream

**Now (plugin repo, no upstream dependency):**

- Document the limitation prominently (README "Install and configure" / a known-limitations section) and link this note.
- Keep steering CoW usage through the agent-facing `spawn_workspace` tool, which works on Desktop sessions because it passes `strategy` explicitly (`src/plugin.ts:73-79`).
- Optionally add a Desktop check to the dogfood/e2e harness that proves the UI path currently yields a git worktree, so the behaviour is tracked rather than implicit.
- Do **not** ship an id-hijack of `"git"` (unsafe; see Q4).

**Needs upstream (one small bug-fix PR on `v2`):**

1. File an issue: "Desktop app forces `strategy: \"git\"`, ignoring the location's selected worktree strategy," referencing the #47358 feature and the #47991 TUI precedent.
2. PR: delete `strategy: "git",` at `packages/app/src/workspaces/create.ts:14`; update `packages/app/src/workspaces/create.test.ts:62-66`. Title e.g. `fix(app): honor configured worktree strategy`, `Closes #<issue>`.
3. Larger, design-review-gated alternatives (not recommended now): surface a strategy choice in the UI, or add a strategy-selection config field.

---

## Open questions / unknowns

- **Is there an App/Desktop-specific reason to force git** (e.g. an assumption in session move, branch handling, or the `from: project.canonical` clone-local-main logic that requires a `.git` gitdir)? No evidence found in the call site, tests, or PR discussion; the TUI fix implies no. **Unverified** — worth one maintainer question before PR.
- **Will the fix change `from`/`branch` semantics?** Deleting only `strategy` leaves `from` and `branch` intact, so source-ref selection is preserved (matching #47358's "retaining Git/source-ref selection" intent while dropping only the strategy override).
- **Whether an upstream issue already exists** — search found none, but this is not exhaustive.
- **The exact local-to-public rev mapping:** the local build rev `7c5a4d0` is on the public `v2` line but is not the current tip; the hardcoded file is byte-identical at the public `v2` tip, so the finding holds for the latest public source as of 2026-09-12.

---

## Cited sources

Build-exact tree (`/nix/store/irlclfmhhwsdbww5m1i13nm41xpaifcd-source`):

- `packages/app/src/workspaces/create.ts:12-17` (literal at 14)
- `packages/app/src/workspaces/create.test.ts:62-66`
- `packages/app/src/new-session/composer-adapter.ts:198-221`
- `packages/app/src/session/timeline/session-workspace-menu.tsx:49-77`
- `packages/app/src/new-session/workspace/controller.ts:101-107,200-204`
- `packages/app/src/workspaces/paths.ts:15-19`
- `packages/schema/src/worktree.ts:11-20,34-37`; `packages/schema/src/config/worktree.ts:5-9`
- `packages/protocol/src/groups/worktree.ts:37-51`
- `packages/server/src/handlers/worktree.ts:9-27`
- `packages/core/src/worktree.ts:141-156,236,260,291-303,314-334`
- `packages/core/src/worktree/git.ts:15,33`
- `packages/plugin/src/promise/worktree.ts:5-23`
- `packages/desktop/package.json:39`
- `services/www/src/docs/content/build/plugins/index.mdx:994,1013,1153-1509`
- `CONTRIBUTING.md:3-12,80,82,84,98-106`; `LICENSE:1-3`

Upstream:

- `anomalyco/opencode` API: `private:false`, `archived:false`, `default_branch:dev`, `license: MIT`
- commit `96d84626f861e29cbf85be6ea3cf5ec1bc8e9b50` (file birth, PR #45735)
- commit `c30285c14880fa0208cb1a845ce71e26f76d1ffb` / PR #47358 (plugin strategies)
- PR #47991 / merge `ccbc018072c2c23e1331cb84b45515b351564365` (TUI fix)
- `https://raw.githubusercontent.com/anomalyco/opencode/v2/packages/app/src/workspaces/create.ts` (literal still present)

Plugin repo:

- `docs/e2e/findings.md:263-311` (prior findings §14/§15)
- `docs/adr/0001-cow-clone-as-worktree-strategy.md`
- `src/plugin.ts:73-79,100-105`
