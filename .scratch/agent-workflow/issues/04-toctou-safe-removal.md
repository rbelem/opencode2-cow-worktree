# 04: TOCTOU-safe removal (tier B)

**What to build:** removing a CoW worktree becomes identity-captured and
quarantine-renamed, so a swapped or recycled path can never be deleted in
place of the audited one, and an agent holding a cwd inside the worktree
stops blocking the path. Order: the existing dirty/unknowable guard (which
must still precede every mutation) → stat the worktree directory, capturing
dev+inode → rename it to a sibling quarantine name (e.g.
`.cow-removing-<name>-<rand>`) → re-stat the quarantine path; dev+inode must
match the capture or the operation aborts loudly attempting a rename-back →
perform the existing deletion mechanics against the quarantine path →
upstream prune/verification exactly as today. The slow tail — dependency
directories like `node_modules` — is deleted asynchronously in-process
(server is long-lived) after the removal returns, with failures logged, never
thrown. Any failure leaves the original directory intact when possible;
double failures chain both errors (house style at `dcc8ce1`: plain `Error`).

**Work happens in the provided CoW clone; commit on branch `lane-b`. Never
push, fetch, or touch the origin remote.**

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] Guard still precedes every mutation; all existing refusal tests pass
      unchanged in meaning
- [x] Identity capture + quarantine rename + re-validation implemented;
      mismatch aborts, attempts rename-back, original intact
- [x] Deletion of the renamed directory cannot delete a different directory
      than the one whose identity was captured (pinned by test)
- [x] `node_modules`-class directories are removed asynchronously after the
      removal returns; errors logged, never thrown into the remove path
- [x] Removal still registers as removed upstream (prune/verify semantics
      preserved); existing harness remove scenarios still pass
- [x] Unit-covered to the repo gate (100% lines + functions); typecheck clean
- [x] README removal section documents quarantine + async tail
- [x] Committed on `lane-b` in the provided clone
