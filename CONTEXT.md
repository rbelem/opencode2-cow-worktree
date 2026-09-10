# CoW Worktree Strategy

A plugin for opencode2 that adds a copy-on-write worktree strategy, so parallel
agents can each get a cheap, fully independent working directory.

This glossary defines the language of this project. It names concepts, not APIs.

## Language

### opencode2 concepts we build on

**Workspace**:
A logical unit that opencode2 tracks by id (`wrk_…`), created with a provider.
It is a lifecycle handle, not a directory.
_Avoid_: repo, project, checkout

**Location**:
Where a session runs, expressed as `{ directory, workspaceID? }`. A session
without a workspace id runs in the project's primary checkout.
_Avoid_: cwd, path

**Worktree**:
A working directory materialized for a workspace by a **Strategy**. opencode2
owns its lifecycle: create, remove, list, refresh, and the project setup script.
_Avoid_: branch, clone

**Strategy**:
The pluggable mechanism that materializes and removes a worktree. opencode2
registers one built-in strategy, `git`, and lets a plugin register more. A
registered strategy becomes the location's default; a caller may still name one
explicitly.
_Avoid_: provider, backend, driver

### this plugin

**CoW clone**:
A whole-directory copy whose file extents are shared with the source until
either side writes. The clone occupies almost no additional space at creation.
Created by a reflink (`FICLONE`, `clonefile`, block cloning) or a filesystem
snapshot. Requires the source and the clone to be on the same filesystem.
_Avoid_: reflink (name the operation, not the result), snapshot (unless a
filesystem snapshot is actually used)

**Deep clone**:
A CoW clone of the entire working directory, including files git does not
track: ignored build output, dependency directories, environments, local
config. This is the reason to prefer a CoW clone over the `git` strategy.
_Avoid_: full copy, mirror

**Shallow worktree**:
A worktree produced by the built-in `git` strategy. It carries tracked files
only and shares the repository's object database. It cannot carry ignored
state.
_Avoid_: partial clone, normal worktree

**CoW capability**:
Whether a given directory's filesystem can satisfy a CoW clone. Determined by
attempting a clone, not by inspecting the filesystem type.
_Avoid_: fs support, reflink support

### informal

**Lane**:
Informal shorthand for one parallel worker's worktree. It is not a type in the
code; the code says Worktree and Strategy. Used in prose and commit messages
only.
_Avoid_: using Lane for an opencode2 Workspace or Location
