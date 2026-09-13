# 06: Lane workflow hardening — spawn helper + conventions doc

**What to build:** encode the ad-hoc lane procedure from the parallel-lane
iteration into a repeatable helper and a short doc, so the next set of
parallel lanes needs no archaeology.

1. A small `scripts/lane.ts` (bun-runnable) with two verbs:
   - `spawn <name> [count]` — CoW-clone the repo into
     `../cow-lane-<name>` via `src/cloneDirectory`, **remove the inherited
     origin remote** (each clone carries the live credential-bearing GitHub
     remote otherwise), create branch `lane-<name>`, print the paths.
   - `absorb <name>` — the merge-side steps: terminal-check, lock-free
     porcelain check, tip pin, `git fetch <path>`, scope-diff stat, and the
     merge (default `--no-ff`; dcg blocks rebase, so plan B is the default).
2. `docs/lane-workflow.md` — the conventions, citing
   `docs/research/lane-merge-mechanics.md`: spawn → work → commit on branch →
   terminal → absorb checklist; `git --no-optional-locks` for any live-lane
   probe; what does not travel (uncommitted work, stash, config, ignored
   files); post-absorb cleanup (remote remove, clone deletion frees only
   exclusive bytes).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `spawn` produces a runnable clone (tests run in-lane) with no origin
      remote and the branch created
- [ ] `absorb` performs the read-only pre-checks before any merge and
      refuses when the lane has uncommitted work or is not terminal
- [ ] Script covered per the repo's testing conventions for `scripts/`
- [ ] `docs/lane-workflow.md` matches the research doc and the actual script
      behavior
- [ ] README (or the docs index, wherever the repo surfaces docs) links it
