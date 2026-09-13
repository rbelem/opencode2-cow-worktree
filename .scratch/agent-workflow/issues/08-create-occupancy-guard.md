# 08: Create-path occupancy guard — never merge into, or delete, a foreign directory

**Found by:** triple-critic review (2026-09-13). Verified: `clone.ts:53` does
`mkdir(target, { recursive: true })`, which succeeds on an existing non-empty
directory; Linux `copyFile` runs `FICLONE_FORCE` without `COPYFILE_EXCL`
(Darwin has EXCL implied), so per-file writes overwrite. In the window between
`tryAttach`'s existence check and the strategy's clone, a directory appearing
at the predicted path is silently merged into on Linux, and a subsequent clone
or hook failure runs the in-place rollback `rm` on a directory the plugin
never created. This breaks `tool.ts`'s "every interleaving fails closed"
claim and falsifies the "seconds-old clone, provenance known" rollback
rationale.

**What to build:**

1. `cloneDirectory` refuses an existing target: if `target` (resolved) exists
   at all — `lstat`, any type — throw a plain house-style `Error` naming the
   path (`cannot clone into <to>: it already exists`). Rationale to encode in
   the doc comment: `cow` never writes into or deletes bytes it did not
   create; a pre-existing path is always the caller's mistake to resolve.
   This guard is the root-cause fix — it makes the rollback `rm` unable to
   observe foreign content on any entry path, independent of per-file flags
   and of upstream's assembly behavior.
2. Linux parity: add `constants.COPYFILE_EXCL` to the `copyFile` mode in
   `src/platform.ts` `cloneOnLinux`, matching Darwin's implied EXCL. Belt and
   suspenders under the entry guard; also correct on its own.
3. Pins: target-exists refusal (dir, file, symlink), the race interleaving
   (a directory appearing between the attach check and the clone now fails
   the create instead of merging — pin at the `cloneDirectory` level), a
   failed create after refusal leaves the foreign directory untouched (no
   rollback), Linux cloneFile with EXCL refuses an existing destination file.
4. Check no existing behavior regresses: the capability probe clones into a
   fresh `mkdtemp` scratch path (never pre-existing) and the e2e harness
   creates fresh names; both stay green.

**Blocked by:** None.

**Status:** ready-for-agent

- [x] `cloneDirectory` refuses any pre-existing target with the house error
- [x] Linux `cloneFile` passes `COPYFILE_EXCL`
- [x] Race pin: a foreign directory at the target path survives a refused
      create untouched
- [x] `bun test`, `bun run typecheck`, `bun run test:coverage` all green
