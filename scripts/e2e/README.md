# e2e dogfood harness

`bun scripts/e2e/harness.ts` proves the plugin works inside a real opencode2
installation, with a parallel worktree fan-out — as opposed to the unit tests,
which prove the plugin's own seams. It is the artifact for issue #8.

## Run

```bash
bun scripts/e2e/harness.ts              # full run against the installed opencode2
bun scripts/e2e/harness.ts --keep       # leave the throwaway config root for inspection
bun scripts/e2e/simulation-run.ts       # only the issue-#9 simulation scenario
```

Environment knobs: `E2E_FANOUT` (default 3), `E2E_PORT` (default 45980; the
non-CoW servers use `+1`, `+2`, and the two simulation rounds use `+3`, `+4`).
Requires `opencode2` on `PATH`, `git`, `cp`, and `btrfs` (for the extent
measurement).

## Simulation (issue #9)

The last two steps drive a real session through opencode2's compiled-in
simulation harness. `OPENCODE_SIMULATE=1` swaps only the `HttpClient` layer;
`OPENCODE_DRIVE=1` starts a backend websocket that answers the provider's chat
request from the controller's scripted events. The model's bytes are scripted;
the session runner, tool registry, tool decoding, and tool execution are the
real binary's code.

- `scripts/e2e/drive.ts` — the controller: `simulation.handshake` + `llm.attach`,
  then answers each `llm.request` with `llm.chunk` items and an `llm.finish`.
- `scripts/e2e/simulation.ts` — boots the server under simulation, runs a real
  session, scripts one tool call, and reads the result out of the transcript.

The scripted builtin `shell` call executes for real (its output is in the
transcript), which proves the loop is real. The scripted `spawn_workspace` call
does **not** run: opencode2 offers the session only its builtin tools, so the
plugin's tool is unreachable. See [`findings.md`](../../docs/e2e/findings.md)
finding 9. #9's acceptance criterion is therefore not met and the ticket stays
open; the scenario records the observed facts instead of a false pass.

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
9. Drives a real session through the compiled-in simulation harness and scripts a
   builtin `shell` tool call, proving the session loop and tool execution are
   production code (finding 10); records that the plugin tool is not offered to
   the session (finding 9).
10. Removes the worktrees through the API and asserts no directories remain.
11. Writes the run log to [`docs/e2e/run-<date>.md`](../../docs/e2e/) and tears the
    throwaway root down.

Exit code is `0` when every check passes, `1` otherwise.

## What it proves

Plugin install through the real loader; a real parallel fan-out each in its own
working directory; genuine independence; the mechanism matches the directory
produced (Deep clone, shared extents, inventory says `cow`); fail-loud on a
non-CoW filesystem; clean removal; and — under the compiled-in simulation
harness — a real session loop where a scripted tool call executes in the server
process.

## What it cannot prove

- macOS/APFS (no machine; #7 owns that).
- Filesystems other than btrfs and tmpfs.
- The fallback opt-in end-to-end: `POST /api/worktree` calls the strategy
  directly, so the fallback (which lives in the `spawn_workspace` tool) is
  unreachable that way. See [`findings.md`](../../docs/e2e/findings.md).
- That the plugin's `spawn_workspace` tool is reachable from a session: opencode2
  offers a session only its builtin tools (finding 9).
- A **real LLM** agent loop: the model's bytes are scripted by the drive
  controller. A genuine-model run would need a real credential and should be an
  opt-in, non-CI lane.

## Layout

- `harness.ts` — the entry point and step sequence.
- `lib.ts` — temp roots, the scratch source repo, config/plugin installation, the
  HTTP client.
- `server.ts` — start `opencode2 serve`, discover readiness, await activation.
- `scenarios.ts` — fan-out, independence, deep-clone, inventory, removal, the
  non-CoW runs.
- `drive.ts` — the simulation drive controller (scripts the model's bytes).
- `simulation.ts` — the real-session-under-simulation scenario (issue #9).
- `simulation-run.ts` — runs only that scenario, for focused iteration.
- `assertions.ts` — the checks and the btrfs extent measurement.
- `runlog.ts` — renders the committed run log.

Findings and the recorded run live in [`docs/e2e/`](../../docs/e2e/).
