# 01: Attach semantics for spawn_workspace

**What to build:** an agent calling `spawn_workspace` with a `name` whose CoW
worktree already exists gets a **fresh session bound to the existing worktree**
("attach"), with the result text saying attached instead of created. Attach is
offered only when the worktree is ours: it appears in the upstream worktree
inventory with `strategy: "cow"` **and** the directory is a Deep clone (`.git`
is a directory). Anything else — missing from inventory, a `git`-strategy
worktree, an unregistered/foreign path — is refused with a loud error naming
what was found; no session is created and no fs mutation happens on refusal.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Second `spawn_workspace` call with the same name succeeds, creates a
      new session in the existing worktree, result text says attached
- [ ] Same-named `git`-strategy worktree → refusal naming the strategy; no
      session created
- [ ] Unregistered/foreign path at the target name → refusal; no session, no
      fs mutation
- [ ] Attach and every refusal branch unit-covered to the repo gate (100%
      lines + functions)
- [ ] e2e harness scenario demonstrates attach on a live server
- [ ] README documents attach behavior
