# CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to
`main` and every pull request. Two jobs, both using
`oven-sh/setup-bun@v2` (Bun pinned to a major, `1.x`):

| Job | Runner | Steps |
| --- | --- | --- |
| `linux` | `ubuntu-latest` | install, `bun run typecheck`, filesystem-independent unit tests |
| `macos` | `macos-latest` | install, `bun run typecheck`, filesystem-independent unit tests (**early warning only**) |

There is no publish or release job; the package is `private: true`.

## What CI proves

- The plugin typechecks (`tsc --noEmit`).
- The filesystem-independent unit tests pass:
  - `test/config.test.ts` — option parsing.
  - `test/capability.test.ts` — the CoW predicate, including the unsupported
    and error branches driven through an injected clone attempt, plus a
    supported-branch test that runs only when it finds a CoW filesystem.
  - `test/platform-darwin.test.ts` — the Darwin backend's logic through an
    injected fake syscall.
- On macOS only, that the above also holds on Darwin.

## What CI does **not** prove

- The Darwin `copyfile(3)` backend against a real APFS filesystem. Its logic is
  tested with an injected syscall; the real syscall path is never run. Issue #7
  is closed only by a human on real APFS hardware pasting verification output.
  A green `macos` job is an early warning and nothing more.
- The full CoW path end to end. The e2e harness
  (`scripts/e2e/`) is not run in CI at all.
- Anything requiring a btrfs or tmpfs filesystem mount.

## The filesystem portability gap (a real finding)

Five test files hardcode the author's environment:

- `/tmp/opencode` as a **CoW (btrfs)** root.
- `/dev/shm` as a **non-CoW (tmpfs)** root.

A GitHub-hosted runner has neither: `/tmp/opencode` does not exist, `/tmp` is
not btrfs, and macOS has no `/dev/shm`. Those tests therefore fail or error for
environmental reasons, not code regressions.

`test/capability.test.ts` already handles this correctly: it calls
`findCowBase()` and skips the supported-branch test when no CoW filesystem is
present. The other files assume one. This is the portability gap.

**CI does not run those files and does not pretend they pass.** The files are
excluded by name in the workflow comments rather than being silenced with
`continue-on-error` or an `exit 0`. Excluded until the suite is made
filesystem-adaptive:

| File | Why it cannot gate |
| --- | --- |
| `test/clone.test.ts` | every test clones into `/tmp/opencode`; one test also runs `btrfs filesystem du` |
| `test/strategy.test.ts` | creates its scratch repos on `/tmp/opencode` |
| `test/tool.test.ts` | last two tests create a scratch dir on `/tmp/opencode` and assert `cow` |
| `test/plugin-fallback.test.ts` | two tests create a scratch dir on `/tmp/opencode` |
| `test/platform.test.ts` | Linux CoW tests create a scratch dir on `/tmp/opencode` |

### Follow-up (not done here)

The durable fix is on the test side, out of this change's scope: make each file
detect a CoW root (and a non-CoW root) like `capability.test.ts` does, and
`skipIf` when the environment cannot provide one. Then the whole suite can gate
on any runner. An alternative — provisioning a loopback btrfs mount at
`/tmp/opencode` in CI — would let the current tests pass, but it would not help
a developer on ext4 running `bun test` locally, so it is a stopgap, not the
fix.

## Lockfile

There is no `bun.lock`/`bun.lockb` committed. CI resolves dependencies fresh
(`bun install`). If a lockfile is added, the workflow already switches to
`bun install --frozen-lockfile` via its existence check. Adding a lockfile is a
reasonable follow-up; it is not required for CI to work.
