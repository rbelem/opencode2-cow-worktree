# CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to
`main` and every pull request. Two jobs, both using `oven-sh/setup-bun@v2` (Bun
pinned to a major, `1.x`):

| Job | Runner | Steps |
| --- | --- | --- |
| `linux` | `ubuntu-latest` | install, `bun run typecheck`, full `bun test` |
| `macos` | `macos-latest` | install, `bun run typecheck`, full `bun test` (**early warning only**) |

There is no publish or release job; the package is `private: true`.

## What CI proves

- The plugin typechecks (`tsc --noEmit`).
- The **full** unit suite passes (or skips for environmental reasons it names):
  - `test/config.test.ts` — option parsing.
  - `test/capability.test.ts` — the CoW predicate, including the unsupported
    and error branches driven through an injected clone attempt.
  - `test/platform-darwin.test.ts` — the Darwin backend's logic through an
    injected fake syscall.
  - `test/clone.test.ts`, `test/strategy.test.ts`, `test/tool.test.ts`,
    `test/plugin-fallback.test.ts`, `test/platform.test.ts` — the real
    filesystem tests, which discover their roots at runtime (below).
- On macOS only, that the above also holds on Darwin.

## What CI does **not** prove

- The Darwin `copyfile(3)` backend against a real APFS filesystem. Its logic is
  tested with an injected syscall; the real syscall path is never run. Issue #7
  is closed only by a human on real APFS hardware pasting verification output.
  A green `macos` job is an early warning and nothing more.
- The full CoW path end to end. The e2e harness
  (`scripts/e2e/`) is not run in CI at all.
- The **positive** CoW path on a runner. A GitHub-hosted runner has no
  copy-on-write filesystem, so those tests skip there. The CoW clone is proven
  on a CoW-capable machine (this project's btrfs host), not in CI.

## Filesystem discovery (`test/fs-roots.ts`)

The filesystem-dependent tests no longer hardcode `/tmp/opencode` (btrfs) or
`/dev/shm` (tmpfs). A shared helper, `test/fs-roots.ts`, discovers both roots
once per process:

- **`findCowRoot()`** probes candidate bases — `/tmp/opencode` (this project's
  historical btrfs scratch root, tried first when present), `homedir()`,
  `tmpdir()`, and `cwd()` — and returns the first directory whose filesystem
  can satisfy a CoW clone. The probe is the plugin's own predicate,
  `probeCowCapability` in `src/capability.ts`: it attempts a real forced
  reflink of a temporary file and only a **definitive** success counts.
- **`findNonCowRoot()`** probes `/dev/shm`, `tmpdir()`, `homedir()` and `cwd()`
  and returns the first directory whose filesystem **definitively** refuses a
  clone. A definitive negative (EOPNOTSUPP/ENOTSUP/ENOTTY/EINVAL/EXDEV/ENOSYS)
  is distinguishable from an unexpected error (permissions, a missing path); an
  unexpected error never counts as a capability answer. `/dev/shm` is no longer
  assumed — it is one candidate among several.
- **`hasGit()`** reports whether `git` is on PATH; tests that build scratch
  repositories gate on it, so a machine without git skips rather than fails.

Both probes are cached per directory by `probeCowCapability`, so a root is
probed once regardless of how many test files ask for it.

Each test then skips with a visible reason when its root is unavailable:

```ts
const cowRoot = await findCowRoot();
test.skipIf(cowRoot === undefined)(...)
```

Skips are honest, in the test output, and countable. There is no
`continue-on-error`, no `exit 0`, and no file excluded by name.

## What runs and skips where

| Environment | CoW tests | Non-CoW tests | Filesystem-independent tests |
| --- | --- | --- | --- |
| This btrfs host | **run** (real clone) | **run** (tmpfs) | run |
| GitHub Linux runner | skip (no CoW fs) | run (tmpfs) | run |
| GitHub macOS runner | skip (no CoW fs) | skip if no non-CoW fs found | run |
| ext4 developer laptop | skip (no CoW fs) | run (tmpfs or ext4) | run |

On this project's btrfs machine the positive path runs for real — the tests do
not silently skip here. On a runner they skip cleanly rather than fail for an
environmental reason. A skip on a runner is visible in the log, so a green job
never pretends the CoW clone ran when it did not.

### Residual environment assumptions

- `test/clone.test.ts` drives `btrfs filesystem du` for the extent-sharing
  test. A CoW filesystem need not be btrfs, so that test additionally requires
  btrfs-progs on PATH against the discovered root; it skips when either is
  absent (`canMeasureBtrfsExtents`).
- Tests that build scratch git repositories require `git` on PATH and skip via
  `hasGit()` when it is missing.
- `/dev/shm` size is not an assumption: the negative tests write a small
  scratch tree only.

## Lockfile

There is no `bun.lock`/`bun.lockb` committed. CI resolves dependencies fresh
(`bun install`). If a lockfile is added, the workflow already switches to
`bun install --frozen-lockfile` via its existence check. Adding a lockfile is a
reasonable follow-up; it is not required for CI to work.
