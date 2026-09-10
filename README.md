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

## How it plugs in

opencode2 already owns worktree lifecycle. This plugin registers one more
**Strategy** through the plugin API:

```ts
await ctx.worktree.transform((editor) =>
  editor.add({
    id: "cow",
    create: async (input, { signal }) => ({ directory: await clone(input, signal) }),
    remove: async (input) => { await rm(input.directory, { recursive: true, force: input.force }); },
    list: async () => [],
  }),
)
```

Everything else is inherited: create, remove, list, refresh, the recorded
strategy used at removal time, the project setup script. Passing
`strategy: "git"` selects the built-in git worktree instead, which is the
fallback. See `docs/adr/0001`.

## Status

Scaffolding. Nothing runs yet.

- [x] Repository, glossary (`CONTEXT.md`), ADR 0001
- [ ] CoW capability probe (attempt a clone, not inspect the filesystem)
- [ ] Recursive reflink clone of a working directory
- [ ] `cow` strategy registration
- [ ] Probe-driven tool that picks `cow` or falls back to `git`
- [ ] Tests against a scratch repository

## Vocabulary

See [CONTEXT.md](CONTEXT.md). In short: a **Workspace** is a logical handle, a
**Location** is where a session runs, and a **Worktree** is a directory
materialized by a **Strategy**.

## License

MIT
