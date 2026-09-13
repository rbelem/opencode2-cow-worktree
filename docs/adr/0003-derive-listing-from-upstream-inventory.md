# Derive worktree listing from upstream inventory, no plugin-owned registry

**Status:** accepted (2026-09-13)

The plugin needs to list and verify its worktrees (`list_worktrees` tool,
attach-mode `spawn_workspace`). The obvious workbench pattern (raine/workmux)
is a plugin-owned registry — per-worktree metadata written into repo-local git
config at create time. We decided **not** to build one. Upstream opencode2
already owns worktree lifecycle and inventory (`ctx.worktree.list()` returns
`{directory, strategy}` per entry), so the plugin derives everything it needs:
name from the directory basename, existence from the inventory, "ours" from
`strategy: "cow"` plus a Deep-clone check, age from a directory stat. This
keeps the create path a single ~25 ms atomic reflink with no new write path,
no lock, and no on-disk state that can go stale.

## Considered options

- **Git-config registry** (workmux-faithful, `cow.worktree.<name>.*` keys):
  rejected — adds a write path, a concurrency lock, and a staleness surface to
  the create flow, for metadata upstream already derives or a stat can
  produce.
- **In-memory session map** (sessions our own `spawn_workspace` created):
  rejected — a blind spot after server restart is worse than an honest
  absence; server plugins cannot enumerate sessions anyway (only the TUI
  context exposes a full client).

## Consequences

- `list_worktrees` v1 omits a sessions field; session visibility for server
  plugins is tracked as an upstream-considerations candidate in
  `docs/research/upstream-issues.md`.
- **Revisit trigger:** the deferred tiers (pre-remove hooks, TOCTOU-safe
  quarantine removal, per-project defaults) need per-worktree bookkeeping of
  facts the inventory does not carry. When that tier starts, a registry
  becomes the right tool and this ADR gets superseded.
