# e2e dogfood harness

`bun scripts/e2e/harness.ts` proves the plugin works inside a real opencode2
installation, with a parallel worktree fan-out — as opposed to the unit tests,
which prove the plugin's own seams. It is the artifact for issue #8.

## Run

```bash
bun scripts/e2e/harness.ts          # run against the installed opencode2, tear down
bun scripts/e2e/harness.ts --keep   # leave the throwaway config root for inspection
```

Environment knobs: `E2E_FANOUT` (default 3), `E2E_PORT` (default 45980; the two
non-CoW servers use `+1` and `+2`). Requires `opencode2` on `PATH`, `git`, `cp`,
and `btrfs` (for the extent measurement).

## What it does

1. Creates a throwaway root and isolates the server into it through `HOME`,
   `OPENCODE_CONFIG_DIR`, and the XDG variables. The user's real config is never
   touched.
2. Installs the plugin by directory (a directory with an `index.ts` that
   re-exports `src/plugin.ts`) and declares it under the `plugins` config key.
3. Starts a real `opencode2 serve`, waits for it, and awaits plugin activation.
4. Fans out three worktrees with `POST /api/worktree {strategy:"cow",…}` and starts
   a session in each with `POST /api/session`.
5. Runs the falsifiable independence proof: each worktree writes a uniquely named
   marker and appends its own id to a shared-named log; each must see only its own
   id and none of the others' markers, and the source must be untouched.
6. Verifies each directory is a Deep clone (ignored files present, symlink is a
   link, real standalone `.git`, matching `git status`) and shares extents with the
   source against a `cp --reflink=never` control.
7. Asserts `GET /api/worktree` lists each directory with `strategy: "cow"`.
8. Runs the non-CoW branch on a tmpfs source under `/dev/shm`: requesting `cow`
   fails loudly and leaves no directory.
9. Removes the worktrees through the API and asserts no directories remain.
10. Writes the run log to [`docs/e2e/run-<date>.md`](../../docs/e2e/) and tears the
    throwaway root down.

Exit code is `0` when every check passes, `1` otherwise.

## What it proves

Plugin install through the real loader; a real parallel fan-out each in its own
working directory; genuine independence; the mechanism matches the directory
produced (Deep clone, shared extents, inventory says `cow`); fail-loud on a
non-CoW filesystem; clean removal.

## What it cannot prove

- macOS/APFS (no machine; #7 owns that).
- Filesystems other than btrfs and tmpfs.
- The fallback opt-in end-to-end: `POST /api/worktree` calls the strategy
  directly, so the fallback (which lives in the `spawn_workspace` tool) is
  unreachable that way. See [`findings.md`](../../docs/e2e/findings.md).
- A real LLM agent loop: the isolated config has no provider credentials, so the
  harness performs the per-worktree edits itself. The independence proof is
  unaffected — it tests shared mutable state, not model reasoning.

## Layout

- `harness.ts` — the entry point and step sequence.
- `lib.ts` — temp roots, the scratch source repo, config/plugin installation, the
  HTTP client.
- `server.ts` — start `opencode2 serve`, discover readiness, await activation.
- `scenarios.ts` — fan-out, independence, deep-clone, inventory, removal, the
  non-CoW runs.
- `assertions.ts` — the checks and the btrfs extent measurement.
- `runlog.ts` — renders the committed run log.

Findings and the recorded run live in [`docs/e2e/`](../../docs/e2e/).
