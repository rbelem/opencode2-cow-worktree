# 0001 — CoW clone implemented as a worktree strategy

Status: accepted

## Context

Parallel agents need isolated working directories. opencode2 already models
this: a **Workspace** is a logical handle, a **Location** is where a session
runs, and a **Worktree** is a directory materialized by a **Strategy**. The
built-in strategy is `git`, which runs `git worktree add --detach` and therefore
carries tracked files only — it shares the repository's object database and
cannot carry ignored state such as dependency directories, build caches, or
local environment files.

On a copy-on-write filesystem we can do better: clone the entire working
directory, ignored files included, at the cost of shared extents rather than a
real copy. That gives an agent a complete, independent checkout in milliseconds
and near-zero disk.

The question was where to attach this capability. Three shapes were
considered.

## Decision

Implement the CoW clone as a **worktree strategy** registered through the
plugin API, `ctx.worktree.transform(editor => editor.add(...))`, using a
free-choice strategy id.

Consequences of this choice, all of which follow from the existing worktree
subsystem rather than from our code: create, remove, list, and refresh come
free; `remove` consults the strategy recorded at creation time, so our clones
are cleaned up by the same route as git worktrees; the project setup script
runs after creation; a caller may still select `git` explicitly, which is the
fallback path; and registering the strategy makes it the location's default.

## Considered options

**A separate subsystem owning clones.** Rejected. It would duplicate lifecycle,
inventory, and cleanup that opencode2 already implements, and would produce
directories invisible to `worktree.list` and `worktree.refresh`.

**A workspace provider.** Plausible, because a CoW clone is arguably a
different kind of workspace. Rejected because the provider seam governs the
logical workspace handle, not directory materialization. The clone is a way to
produce a directory, which is exactly what a strategy is.

**A first-party config-declared strategy.** Not available today, and would
require forking opencode2 to add a config field and consume it in the built-in
config plugin.

## Notes

- The strategy id is a free non-empty string and selecting a strategy is
  explicit in `CreateInput.strategy`, so "fall back to git" is not a special
  case in our code — it is simply not passing `cow`.
- CoW capability is probed by attempting a clone. Filesystem type is not
  sufficient evidence: availability is a format-time property on some
  filesystems, and a clone can still fail across device boundaries.
