# 02: list_worktrees agent tool

**What to build:** a new agent tool, registered alongside `spawn_workspace`,
listing the current Location's CoW worktrees. Each entry carries the
directory basename as `name`, plus `directory`, `strategy`, and `createdAt`
(from a directory stat). Per ADR 0003 there is **no sessions field** — data
is derived from the upstream worktree inventory, never a plugin-owned
registry.

**Blocked by:** 01 (shares the inventory-read seam introduced there; same
files).

**Status:** ready-for-agent

- [x] Tool lists only `cow`-strategy worktrees with the four fields
- [x] Empty inventory → empty list result, no error
- [x] Unit-covered to the repo gate (100% lines + functions)
- [x] e2e harness scenario lists created worktrees on a live server
- [x] README documents the tool
