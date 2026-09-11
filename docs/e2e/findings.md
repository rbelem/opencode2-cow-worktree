# e2e findings

Analysis that accompanies [`run-2026-09-11.md`](./run-2026-09-11.md). Every finding
below was produced by running `scripts/e2e/harness.ts` against the real
`opencode2 v0.0.0-next-20260910` binary, not by reading its source. This is the
ticket's most valuable output: what the design got wrong about the real server.

## 1. The config key is `plugins` (plural), not `plugin` (singular)

Declaring `plugin: [{ package, options }]` produces:

```
configuration normalization diagnostic source=... path=$.plugin.0 kind=invalid
  action="skipped malformed recognized value"
```

and the plugin silently never loads. The schema
(`packages/schema/src/config/plugin.ts`) names the field `plugins`. The #1 spike's
note that "the plugin configuration key is `plugin` (singular)" does not hold for
this build. `src/config.ts` reads the plugin's `options`; the field that carries
those options is `plugins`.

## 2. A configured plugin target must be a directory, not a file

Pointing an entry at the repo's `src/index.ts` logs
`configured plugin path must be a directory` and skips it entirely. The target
must be a directory from which `Host.resolve` finds an `index`/`server` entrypoint.
The harness installs a directory whose `index.ts` re-exports the repo's
`src/plugin.ts`, which is the same shape a user installing a plugin directory
would get.

## 3. `GET /api/plugin` does not await activation

Immediately after boot the list is empty (or the builtin set); the configured
plugin appears only after `POST /api/plugin/await-activation` resolves. The
handler for `plugin.list` reads the inventory directly, while `plugin.check` and
the worktree handlers await activation first. A client that lists without awaiting
activation concludes, wrongly, that the plugin is absent.

## 4. `GET /api/worktree` returns a bare array

Every other endpoint read here wraps its payload in `{ data }` (sessions, plugins,
location). The worktree list returns the array itself. A client written against
the wrapper shape reads `undefined` and reports no worktrees.

## 5. The fallback is tool-only, so the API-direct backbone cannot reach it

This is the largest discrepancy. `POST /api/worktree` invokes the selected
*strategy* directly (`packages/core/src/worktree.ts`:

```ts
const created = yield* selected.create({ directory, sourceDirectory, branch }).pipe(...)
```

). The fallback policy lives in the `spawn_workspace` *tool*
(`src/tool.ts`), which runs only when an agent invokes it. On a non-CoW source,
`POST /api/worktree {strategy:"cow"}` therefore fails loudly with `cow strategy
failed to clone into …` regardless of `options.fallback` — which is the strategy's
correct fail-loud contract, but it means the design's §6 expectation ("with
`options.fallback: "git"` assert the API produces a worktree reported as git") is
not achievable through the API.

Consequence: the fallback opt-in end-to-end is **deferred**. It is covered at the
tool seam by `test/plugin-fallback.test.ts` (#6), and reaching it against the real
server needs an agent session invoking the tool, which needs provider credentials
(finding 6).

## 6. A real agent fan-out needs provider credentials the isolated config lacks

A prompted session produces the `user` message and nothing else;
`POST /api/session/:id/wait` never returns; the server logs a 401 fetching
provider config. Credentials live in the server's database (not `~/.local/share/opencode/auth.json`,
which is a v1 leftover), and seeding them would mean touching the user's real auth
or fabricating a provider. The harness therefore uses the design's recommended
deterministic backbone (§4(b)): it drives `POST /api/worktree` and
`POST /api/session` directly and performs the per-worktree edits itself. The
independence proof is unaffected — it tests whether the worktrees share mutable
state, which is exactly what a shared working directory would get wrong.

## 7. The server runtime is Bun

The single-file binary contains `Bun v${…}` build strings. So
`COPYFILE_FICLONE_FORCE` reaches the Linux clone path and the `cow` mechanism is
genuine. This is corroborated independently by the shared-extent measurement: the
clone reports its extents as `shared` and almost nothing exclusive, while the
`cp --reflink=never` control shares nothing.

## 8. A non-CoW source must be a project opencode2 has recorded

On `/dev/shm` the first `POST /api/worktree` returned
`Worktree source not found: /dev/shm/cow-e2e-…` until the tmpfs source was a git
repository **and** `POST /api/worktree/refresh` had run. `Worktree.create`'s
`source()` consults the project's recorded worktree inventory, not merely the
filesystem, so a bare directory is not enough.

## What the harness proves

- The plugin installs through the real loader and reaches `active`.
- A fan-out of three worktrees, each with a session started in its own directory,
  through the real HTTP API.
- Each worktree is independent: it sees only its own marker and its own line in
  the shared-named log, and the source is untouched.
- Each produced directory is a Deep clone: ignored files present, symlinks are
  links, a real standalone `.git` with no alternates, matching `git status`.
- Extents are genuinely shared (btrfs measurement, with a byte-copy control).
- `GET /api/worktree` lists each directory with `strategy: "cow"`.
- Removing the worktrees through the API leaves no directories and no inventory
  entries.
- On a real non-CoW filesystem, requesting `cow` fails loudly and leaves no
  directory.

## What the harness cannot prove

- Anything about macOS/APFS — no such machine; #7 is gated on a human there.
- Correctness on filesystems other than btrfs (positive) and tmpfs (negative).
- The fallback opt-in against the real server (finding 5/6).
- That the plugin is "tested enough" — a release judgement made by a person over
  time, deliberately not encoded in this ticket.
- Agent reasoning: the harness asserts filesystem facts, not model behaviour.
