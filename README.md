# opencode2-cow-worktree

A copy-on-write worktree strategy for [opencode2](https://opencode.ai). Gives
each parallel agent a complete, independent working directory — ignored files
included — at the cost of shared extents rather than a real copy.

Work in progress. Not published, not battle tested. Announced only when it is.

## Why

A `git worktree` carries tracked files only: it shares the repository's object
database and cannot carry `node_modules`, build caches, or local environment
files. An agent that expects a ready-to-run checkout and gets a bare one fails
in confusing ways.

On a copy-on-write filesystem we can clone the whole working directory —
tracked and ignored — so it costs milliseconds and almost no disk. That is a
**Deep clone**, and it is the reason this plugin exists.

## Status

The implementation is here and it runs. This plugin:

- registers the `cow` **Strategy** through opencode2's worktree seam;
- ships a `spawn_workspace` tool that probes **CoW capability**, asks for `cow`,
  and reports the **Mechanism** that produced the directory;
- has an opt-in `git` fallback for the tool (`options.fallback`, default
  `"none"`);
- has a Linux backend (per-file `COPYFILE_FICLONE_FORCE` reflink) and a macOS
  backend (`copyfile(3)` with `COPYFILE_CLONE_FORCE` through `bun:ffi`) behind a
  platform seam;
- passes 68 unit tests across 8 files;
- passes an e2e harness run against a real
  `opencode2 v0.0.0-next-20260910` server: 80 of 80 checks.

What the e2e run proved: plugin installation through the real loader, a fan-out
of three parallel **Worktrees** each with a session of its own, genuine
independence (each saw only its own marker and log line; the source was
untouched), a real **Deep clone** per worktree (ignored files present, symlinks
are links, a standalone `.git` with no alternates, matching `git status`), shared
extents measured on btrfs against a `cp --reflink=never` control,
`GET /api/worktree` listing each directory as `strategy: "cow"`, fail-loud on a
tmpfs source, and clean removal.

What it did **not** prove: the run drove `POST /api/worktree` and
`POST /api/session` directly and performed the per-worktree edits itself. The
isolated config had no provider credentials, so this was not a real multi-agent
LLM fan-out — it proves filesystem isolation, not model behaviour. The macOS
backend is unit-tested with an injected syscall only; it remains unverified on
real APFS hardware (issue #7). Green CI does not close that.

- [x] Glossary (`CONTEXT.md`) and ADRs 0001–0002
- [x] CoW capability predicate (attempts a clone, not filesystem inspection)
- [x] Recursive reflink Deep clone of a working directory
- [x] `cow` Strategy registration
- [x] `spawn_workspace` tool with an opt-in `git` fallback
- [x] Linux and macOS backends behind a platform seam
- [x] 68 unit tests
- [x] e2e harness against a real opencode2 server (80/80 checks)
- [ ] macOS/APFS on real hardware — issue #7 needs a human there
- [ ] The fallback exercised through a real tool invocation against the server — issue #9
- [ ] A published release (the package is `private: true`)

## How it plugs in

opencode2 already owns Worktree lifecycle. This plugin supplies how a directory
is materialized, registering the `cow` Strategy and the `spawn_workspace` tool:

```ts
// src/plugin.ts (condensed)
export default {
  id: "opencode2-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    await ctx.worktree.transform((editor) => {
      editor.add(cowStrategy); // registers `cow`, and makes it the Location default
    });
    await ctx.tool?.transform((editor) => {
      editor.add({ name: "spawn_workspace" /* input, execute */ });
    });
  },
};
```

```ts
// src/strategy.ts (condensed)
export const cowStrategy: WorktreeDefinition = {
  id: "cow",
  async create(input, { signal }) {
    signal.throwIfAborted();
    await cloneDirectory(input.sourceDirectory, input.directory); // Deep clone
    return { directory: input.directory };
  },
  async remove(input) {
    await rm(input.directory, { recursive: true, force: input.force });
  },
  list: async () => [], // inventory lives in opencode2, not in the Strategy
};
```

Everything else is inherited from the worktree subsystem: create, remove, list,
refresh, the strategy recorded at removal time, and the project setup script.
Registering `cow` makes it the Location default; passing `strategy: "git"` still
selects the built-in `git` strategy explicitly. `spawn_workspace` is the
caller-facing tool: it probes CoW capability for the source directory, requests
`cow` or the fallback `git`, starts a session in the new directory, and returns
`{ sessionID, directory, mechanism }`. It places the Worktree under a parent on
the **source's own filesystem** — a sibling by default, or `options.targetRoot`
when configured — because a reflink cannot cross a device. If the chosen parent
is on a different filesystem the call fails naming the mismatch, rather than
surfacing a bare `EXDEV`. If a Worktree is created but the session
cannot start, the tool removes that Worktree before the error propagates. See
`docs/adr/0001`.

## Install and configure

The package is `private: true` and unpublished, so there is no `npm install`
line. Today you install it by pointing opencode2 at a local plugin directory.

A configured plugin target must be a **directory**, not a file. opencode2 logs
`configured plugin path must be a directory` and skips a file target. The
directory needs an `index` or `server` entrypoint that opencode2's `Host.resolve`
can find; for this repo, an `index.ts` that re-exports the plugin entry works:

```ts
// /absolute/path/to/cow-plugin/index.ts
export { default } from "/absolute/path/to/opencode2-cow-worktree/src/plugin.ts";
```

Then declare it in `opencode.json`. The config field is **`plugins` (plural)**,
with entries of `{ package, options }`:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/cow-plugin",
      "options": { "fallback": "none" }
    }
  ]
}
```

The field is `plugins`, not `plugin`. Declaring `plugin` (singular) produces a
configuration diagnostic and the plugin silently never loads (findings #1).

`options.fallback` controls the tool's fallback policy:

- `"none"` (the default) — never produce a Shallow worktree. A request for `cow`
  either gets a Deep clone or fails.
- `"git"` — when the source filesystem cannot do a CoW clone, `spawn_workspace`
  may request opencode2's built-in `git` strategy and report `mechanism: "git"`.

Any other value throws when the tool runs, rather than silently degrading.

`options.targetRoot` controls where the tool places the Worktree. It is the
**parent** directory opencode2 creates the worktree under:

- unset (the default) — a sibling of the source (`<source>/..`), which is on the
  source's filesystem by construction.
- a path — used verbatim. If it names a different filesystem than the source,
  a `cow` call fails naming the mismatch; the `git` fallback is unaffected
  because a Shallow worktree shares no extents.

Any other value throws when the tool runs, rather than silently relocating every
clone.

The fallback is **tool-only**. `POST /api/worktree {strategy: "cow"}` invokes the
`cow` Strategy directly, and that Strategy always fails loudly on a non-CoW
source regardless of `options.fallback` (findings #5). Only a `spawn_workspace`
call consults the policy.

Runtime requirements:

- opencode2's server runs on **Bun**. The macOS backend uses `bun:ffi` and
  `copyfile(3)`, and does not work under Node (ADR 0002); the e2e run observed a
  Bun single-file build.
- The Linux backend needs a **CoW filesystem** — btrfs, or XFS with reflink
  enabled. The forced reflink fails rather than silently byte-copying, so on a
  non-CoW filesystem the `cow` Strategy fails loudly. The source and the clone
  must also be on the same filesystem: a reflink does not cross a device
  boundary.
- The macOS backend is `copyfile(3)` with `COPYFILE_CLONE_FORCE` on APFS, and is
  unverified on real hardware — see issue #7.

If you are checking an install, note that `GET /api/plugin` does not await
activation; the configured plugin appears only after
`POST /api/plugin/await-activation` resolves (findings #3). A list taken
immediately after boot can wrongly look empty.

## Testing

```sh
bun test                     # unit tests
bun run typecheck            # tsc --noEmit
bun scripts/e2e/harness.ts   # end-to-end; needs opencode2 on PATH, git, cp, btrfs
```

The unit tests cover capability classification, the recursive Deep clone,
platform dispatch and the Darwin decision logic (with an injected syscall), the
Strategy, the tool's decision table including the fallback, and plugin
registration/fallback wiring.

The e2e harness starts a real `opencode2 serve` against a throwaway config root
that never touches your real config, installs the plugin by directory, activates
it, and runs the fan-out, independence, Deep-clone, inventory, non-CoW
fail-loud, and removal checks. The recorded run is
[`docs/e2e/run-2026-09-11.md`](docs/e2e/run-2026-09-11.md).

What remains unproven, and is not papered over here:

- **macOS/APFS** on real hardware. Issue #7 needs a human on an APFS Mac pasting
  the probe output; the Darwin tests inject the syscall and cannot substitute for
  it. Green CI does not close it.
- The **fallback through a real tool invocation** against the server. The API
  path cannot reach it, so it is deferred to issue #9. It is covered at the tool
  seam by `test/plugin-fallback.test.ts`.
- Filesystems other than btrfs (positive) and tmpfs (negative).
- A real **multi-agent LLM fan-out**. The harness asserts filesystem facts, not
  model reasoning.

## Vocabulary

See [CONTEXT.md](CONTEXT.md). In short: a **Workspace** is a logical handle, a
**Location** is where a session runs, and a **Worktree** is a directory
materialized by a **Strategy**.

## License

MIT
