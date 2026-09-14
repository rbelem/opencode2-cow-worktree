# opencode2-cow-worktree

A copy-on-write worktree strategy for [opencode2](https://opencode.ai). Gives
each parallel agent a complete, independent working directory — ignored files
included — at the cost of shared extents rather than a real copy.

In daily use, and hardened accordingly: a 31-scenario live swarm
(`docs/e2e/run-2026-09-12-swarm.md`), a four-scenario e2e harness, and a 100%
lines-and-functions coverage gate. Not yet published to npm; the install is a
local plugin directory (below).

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
- ships a `list_worktrees` tool that lists the Location's cow worktrees from
  opencode2's worktree inventory (no sessions field; ADR 0003);
- has an opt-in `git` fallback for the tool (`options.fallback`, default
  `"none"`);
- runs configured post-create commands (`options.hooks.postCreate`) at the end
  of every create, in the new worktree, and aborts the create — removing the
  clone — when one fails;
- has a Linux backend (per-file `COPYFILE_FICLONE_FORCE` reflink) and a macOS
  backend (`copyfile(3)` with `COPYFILE_CLONE_FORCE` through `bun:ffi`) behind a
  platform seam;
- passes the unit suite (`bun test`) with a 100% lines-and-functions coverage
  gate on `src/`;
- passes a four-scenario e2e harness (105 checks) against a real opencode2
  server;
- is installed and activated in a real opencode2 config, with CI measuring the
  macOS backend's shared extents on both an arm64 and an x86_64 runner.

What the e2e harness proves (105 checks over four scenarios): plugin
installation through the real loader; `cow` creates driven through the real
API, each with a session of its own; attach, where a second call binds a new
session to the existing directory instead of cloning; `list_worktrees`
reporting the inventory; post-create hooks running, and rolling the create
back when one fails; genuine independence (each worktree saw only its own
marker and log line; the source was untouched); a real **Deep clone** per
worktree (ignored files present, symlinks are links, a standalone `.git` with
no alternates, matching `git status`); shared extents measured on btrfs
against a `cp --reflink=never` control; `GET /api/worktree` listing each
directory as `strategy: "cow"`; fail-loud on a tmpfs source; and clean
removal.

What it did **not** prove: the run drove `POST /api/worktree` and
`POST /api/session` directly and performed the per-worktree edits itself. The
isolated config had no provider credentials, so this was not a real multi-agent
LLM fan-out — it proves filesystem isolation, not model behaviour.

- [x] Glossary (`CONTEXT.md`) and ADRs 0001–0002
- [x] CoW capability predicate (attempts a clone, not filesystem inspection)
- [x] Recursive reflink Deep clone of a working directory
- [x] `cow` Strategy registration
- [x] `spawn_workspace` tool with an opt-in `git` fallback
- [x] Linux and macOS backends behind a platform seam
- [x] Unit tests, and an e2e harness against a real opencode2 server
- [x] A 31-scenario parallel-agent live swarm on
      `opencode2 v0.0.0-next-20260912.3` — clone/isolation/extents, remove +
      dirty guard, `spawn_workspace` options, fresh-binary install/defaults —
      all passing (`docs/e2e/run-2026-09-12-swarm.md`)
- [x] macOS/APFS on real hardware — CI measures shared extents on arm64 and
      x86_64 runners (issue #7)
- [x] The fallback exercised through a real tool invocation against the server
      (issue #9)
- [x] Installed and dogfooded in a real opencode2 config
      (`scripts/dogfood-install-check.ts`)
- [ ] A published release (the package is `private: true`)

## How it plugs in

opencode2 already owns Worktree lifecycle. This plugin supplies how a directory
is materialized, registering the `cow` Strategy and the `spawn_workspace` tool:

```ts
// src/plugin.ts (condensed)
export default {
  id: "opencode2-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    // Every option is validated here, once: a bad value fails the plugin load.
    const hooks = postCreateHooks(ctx.options);
    await ctx.worktree.transform((editor) => {
      editor.add(createCowStrategy({ postCreate: hooks })); // registers `cow`, and makes it the Location default
    });
    await ctx.tool?.transform((editor) => {
      editor.add({ name: "spawn_workspace" /* input, execute */ });
      editor.add({ name: "list_worktrees" });
    });
  },
};
```

```ts
// src/strategy.ts (condensed)
export function createCowStrategy(
  { postCreate }: { readonly postCreate: readonly string[] },
): WorktreeDefinition {
  return {
    id: "cow",
    async create(input, { signal }) {
      signal.throwIfAborted();
      // Deep clone; refuses an occupied target before the first write.
      await cloneDirectory(input.sourceDirectory, input.directory);
      await runPostCreateHooks(postCreate, input.directory, input.sourceDirectory);
      return { directory: input.directory };
    },
    async remove(input) {
      // guard first, then the quarantine removal described under **Removal** below
      await removeQuarantined(input.directory);
    },
    list: async () => [], // inventory lives in opencode2, not in the Strategy
  };
}
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

**Attach.** When a `spawn_workspace` call names a Worktree whose predicted
directory already exists, the tool attaches instead of cloning: it starts a
**new** session bound to the existing directory and reports
`attached: true` with the text "Attached to existing cow worktree …". Attach is
offered only for Worktrees this strategy materialized — opencode2's inventory
must record the directory with `strategy: "cow"` (no plugin-owned registry; ADR
0003) and the directory must carry the Deep-clone signature (`.git` is a
directory). Anything else already at that name is refused loudly before any
session starts and with no filesystem change: a `git`-strategy Worktree, a path
the inventory does not know (a Foreign worktree), or a `cow` row that lost its
Deep-clone shape.

**Occupied targets.** A create whose target path already exists is refused
before the first write: `cow` never merges into, or later deletes, a directory
it did not create. If a directory appears at the predicted path after the
tool's checks and before the clone, the create fails naming the path and
whatever is there is left untouched. Resolve the path and re-run.

**List.** The `list_worktrees` tool lists the Location's CoW worktrees: each
entry carries the directory basename as `name`, plus `directory`, `strategy`,
and `createdAt` from a stat of the directory (birthtime, falling back to mtime
when the filesystem reports none — btrfs does). It is derived from opencode2's
worktree inventory alone — no plugin-owned registry, no git, and no filesystem
contact beyond that stat — and per ADR 0003 it has **no sessions field**:
server plugins cannot enumerate sessions, and an honest absence beats a stale
one. An inventory row whose directory cannot be read fails the list rather
than being silently skipped.

**Removal.** The strategy's `remove` never deletes a worktree path in place.
After the uncommitted-work guard (which still precedes every filesystem
change), the
directory is stat'd to capture its identity (device + inode), renamed to a
sibling `.cow-removing-<name>-<random>` in the same parent, and the quarantine
path is stat'd again: only when the identity still matches is the copy
deleted. A mismatch — the path was swapped or recycled between rename and
check — aborts loudly and moves the worktree back, leaving the original
untouched. The rename also unblocks an agent holding a cwd inside the
worktree: the path is vacated immediately even though its former contents
cannot be fully unlinked until that process lets go.

Deletion is two-phase. Everything except dependency directories
(`node_modules`) is deleted before the removal returns; those are deleted
afterwards, asynchronously in the server process, together with the
`.cow-removing-…` shell. Failures in that background tail are logged, never
thrown. A **leftover** `.cow-removing-…` directory therefore means a deletion
failed midway — the thrown or logged error names it — and it holds the
remains of a removed worktree and nothing else: safe to delete by hand once
no process is using it. Right after a removal returns, a `.cow-removing-…`
sibling can also exist transiently while the tail finishes; it disappears on
its own.

## Install and configure

The package is `private: true` and unpublished, so there is no `npm install`
line. You install it as a **local plugin directory**.

opencode2 auto-discovers every `.ts`/`.js` file under `plugins/`, and a
directory under `plugins/` whose `index`/`server` entrypoint it can resolve. So
the install is a directory with an `index.ts`:

```ts
// ~/.config/opencode/plugins/opencode2-cow-worktree/index.ts
export { default } from "opencode2-cow-worktree";
```

For that bare specifier to resolve, the package must be in a `node_modules`
beside it. Symlink the checkout — opencode2's runtime is Bun, so tracked
working-tree edits are live with no build step:

```sh
ln -sfn /path/to/opencode2-cow-worktree \
  ~/.config/opencode/plugins/opencode2-cow-worktree/node_modules/opencode2-cow-worktree
```

**Do not also declare it in the `plugins` array.** Directory discovery already
picks it up; declaring the same path as a `package` makes opencode2 load the
tree twice, and the package-sourced copy fails with `Plugin failed to load`
because the loader does not follow the symlinked local tree. Verified: with only
directory discovery, `GET /api/plugin` reports
`opencode2-cow-worktree [local] active` and no plugin fails.

### Required: point the worktree directory at the source's filesystem

opencode2's default worktree parent is
`$XDG_DATA_HOME/opencode/worktree/<project>`. A reflink cannot cross a device,
and on many setups (including a separate `/home` or `/tmp`) that default is a
different filesystem from the project — so `cow` fails on the default path while
the built-in `git` strategy is unaffected. opencode2 exposes the setting:

```json
{
  "worktree": { "directory": ".opencode/worktrees" }
}
```

A **relative** value resolves against the project checkout (opencode2's
`opencode.config.worktree` plugin does `path.resolve(location.project.canonical,
directory)`), which puts the clone on the source's own filesystem by
construction. An absolute value is used as-is and must be on the same
filesystem as each project. This is the same concern the tool's `options.targetRoot`
addresses for `spawn_workspace`; the config setting covers the API and UI paths
that call the Strategy directly.

A nested directory like `.opencode/worktrees` is supported: `cloneDirectory`
skips the target subtree rather than cloning the target into itself.

The install can be checked without touching a live session:
`bun scripts/dogfood-install-check.ts` boots a throwaway server against the
installed directory and asserts the plugin activates
(`GET /api/plugin` reports `state.status: "active"`) and that a worktree create
with **no** `strategy` field produces a Deep clone, which proves the `cow`
Strategy became the Location default. Note `GET /api/plugin` returns
`{ location, data }`, not a bare array.

`options.fallback` controls the tool's fallback policy:

- `"none"` (the default) — never produce a Shallow worktree. A request for `cow`
  either gets a Deep clone or fails.
- `"git"` — when the source filesystem cannot do a CoW clone, `spawn_workspace`
  may request opencode2's built-in `git` strategy and report `mechanism: "git"`.

Any other value fails the plugin load at setup, rather than silently degrading.

`options.targetRoot` controls where the tool places the Worktree. It is the
**parent** directory opencode2 creates the worktree under:

- unset (the default) — a sibling of the source (`<source>/..`), which is on the
  source's filesystem by construction.
- a path — used verbatim. If it names a different filesystem than the source,
  a `cow` call fails naming the mismatch; the `git` fallback is unaffected
  because a Shallow worktree shares no extents.

Any other value fails the plugin load at setup, rather than silently relocating
every clone.

### Post-create hooks

`options.hooks.postCreate` runs commands at the end of the `cow` strategy's
create flow, against every worktree the plugin materializes — whatever the
entry path (the HTTP API, the TUI, or `spawn_workspace`):

```json
{
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/opencode2-cow-worktree",
      "options": {
        "hooks": {
          "postCreate": [
            "corepack use pnpm@latest",
            "cp $COW_SOURCE_DIRECTORY/.env.local ."
          ]
        }
      }
    }
  ]
}
```

The commands run sequentially via `sh -c`, each with the new worktree as its
working directory and two absolute paths in its environment:
`COW_WORKTREE_PATH` and `COW_SOURCE_DIRECTORY`. A command that needs a
per-project value reads it from those. A failed or timed-out command (five
minutes per command) aborts the creation: the just-created clone is removed —
no orphan directory — and the error names the failed command, its 1-based step,
and its captured output. Hooks that succeed pass silently. Attach never runs
hooks: it binds a session to an existing worktree and clones nothing.

Hooks are your own configuration, and they run with full shell rights inside
the new worktree: treat the list like a shell script you wrote.

Absent or empty, the option changes nothing. A malformed value — anything that
is not an array of non-empty command strings — fails the plugin load loudly,
like `fallback` and `targetRoot` do.

Per-project values need no new mechanism: opencode2 merges plugin `options`
from a project-level `opencode.json` the same way it merges this file's, so a
project can declare its own `hooks.postCreate` (or `fallback`/`targetRoot`)
list and every other project keeps the global default.

The fallback is **tool-only**. `POST /api/worktree {strategy: "cow"}` invokes the
`cow` Strategy directly, and that Strategy always fails loudly on a non-CoW
source regardless of `options.fallback`. Only a `spawn_workspace` call
consults the policy.

Runtime requirements:

- opencode2's server runs on **Bun**. The macOS backend uses `bun:ffi` and
  `copyfile(3)`, and does not work under Node (ADR 0002); the e2e run observed a
  Bun single-file build.
- The Linux backend needs a **CoW filesystem** — btrfs, or XFS with reflink
  enabled. The forced reflink fails rather than silently byte-copying, so on a
  non-CoW filesystem the `cow` Strategy fails loudly. The source and the clone
  must also be on the same filesystem: a reflink does not cross a device
  boundary. This is why `worktree.directory` must be set (above): opencode2's
  default target is often on a different device.
- The macOS backend is `copyfile(3)` with `COPYFILE_CLONE_FORCE` on APFS. It is
  verified on real APFS hardware: CI measures shared extents with
  `F_LOG2PHYS_EXT` on both an arm64 and an x86_64 macOS runner (`method:
  F_LOG2PHYS_EXT`, block-level Jaccard overlap 1.000000), and mutating a byte
  moves the block while leaving the source unchanged (ADR 0002).

If you are checking an install, note that `GET /api/plugin` does not await
activation; the configured plugin appears only after
`POST /api/plugin/await-activation` resolves. A list taken immediately after
boot can wrongly look empty.

## Testing

```sh
bun test                          # unit tests
bun run typecheck                 # tsc --noEmit
bun scripts/e2e/harness.ts        # end-to-end; needs opencode2 on PATH, git, cp, btrfs
bun scripts/dogfood-install-check.ts  # proves a real config install; needs opencode2 on PATH, git
```

The unit tests cover capability classification (including the cache contract),
the Deep clone and its occupancy refusal, platform dispatch and the Darwin
decision logic (with an injected syscall), the post-create hooks, the
dirty-worktree guard and its git probe, the quarantine removal, the device
seam, the tool's decision table including attach and the fallback, and plugin
registration wiring.

The e2e harness starts a real `opencode2 serve` against a throwaway config root
that never touches your real config, installs the plugin by directory, activates
it, and runs the create, attach, list, hooks, independence, Deep-clone,
inventory, non-CoW fail-loud, and removal checks. Each run is recorded under
[`docs/e2e/`](docs/e2e); the 31-scenario parallel-agent swarm is
[`docs/e2e/run-2026-09-12-swarm.md`](docs/e2e/run-2026-09-12-swarm.md).

What remains unproven, and is not papered over here:

- Filesystems other than btrfs (positive) and tmpfs (negative). The macOS
  backend is proven on real APFS by CI, not by the local harness.
- A real **multi-agent LLM fan-out**. The harness asserts filesystem facts, not
  model reasoning.

## Parallel lanes

This repository is developed with parallel CoW lane clones: `bun
scripts/lane.ts spawn|absorb` spawns them and absorbs them back. The
conventions are in [`docs/lane-workflow.md`](docs/lane-workflow.md); the
verified merge mechanics are in
[`docs/research/lane-merge-mechanics.md`](docs/research/lane-merge-mechanics.md).

## Vocabulary

See [CONTEXT.md](CONTEXT.md). In short: a **Workspace** is a logical handle, a
**Location** is where a session runs, and a **Worktree** is a directory
materialized by a **Strategy**.

## License

MIT
