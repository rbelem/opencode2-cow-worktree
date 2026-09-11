# CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to
`main` and every pull request. Three jobs, all using `oven-sh/setup-bun@v2` (Bun
pinned to a major, `1.x`):

| Job | Runner | Steps |
| --- | --- | --- |
| `linux` | `ubuntu-latest` | install, `bun run typecheck`, full `bun test` |
| `macos` | `macos-latest` | install, `bun run typecheck`, full `bun test` (**early warning only**) |
| `apfs-verification` | `macos-latest` + `macos-15-intel` | install, run the real Darwin backend and measure shared extents (**the #7 evidence job**) |

There is no publish or release job; the package is `private: true`.

## What CI proves

- The plugin typechecks (`tsc --noEmit`).
- The **full** unit suite passes (or skips for environmental reasons it names):
  - `test/config.test.ts` — option parsing.
  - `test/capability.test.ts` — the CoW predicate, including the unsupported
    and error branches driven through an injected clone attempt.
  - `test/platform-darwin.test.ts` — the Darwin backend's logic through an
    injected fake syscall.
  - `scripts/verify-apfs/logic.test.ts` — the APFS verification verdict logic
    (`diskutil`/`df` parsing, the Jaccard overlap thresholds, and the
    copy-on-write mutation verdict). Platform-independent.
  - `scripts/verify-apfs/log2phys.test.ts` — the `log2phys.py` helper's
    argument contract, its non-Darwin guard, and the parser for its stdout.
    Runs on Linux; the real device offsets only exist on macOS.
  - `test/clone.test.ts`, `test/strategy.test.ts`, `test/tool.test.ts`,
    `test/plugin-fallback.test.ts`, `test/platform.test.ts` — the real
    filesystem tests, which discover their roots at runtime (below).
- On macOS only, that the above also holds on Darwin.
- **On macOS only, in `apfs-verification`, that the real Darwin backend
  produces a clone with genuinely shared physical extents.** This is what
  verified and closed issue #7. See below.

## The `apfs-verification` job

The `macos` job never runs the Darwin `copyfile(3)` backend, so a green `macos`
run cannot attest to it. `apfs-verification` exists to close that gap: it runs
`scripts/verify-apfs/verify-apfs.ts` with `--require` on a hosted macOS runner
and gates on **measured evidence**, not on exit code.

What it does, in order:

1. **Asserts the volume is APFS** with `diskutil info` on the scratch
   directory's **mount point** (macOS has no `df -T`) and prints the raw
   output, the macOS version, and `df -Pk`. `diskutil info` accepts a device
   node or a mount point, not an arbitrary subdirectory: the job's first real
   run passed the scratch dir and got `Could not find disk`, which is why the
   mount point is now resolved from `df` first, with the `mount(8)` type as a
   labelled fallback. No official GitHub document states the runner volume's
   filesystem, so the job proves it at runtime and fails loudly if it is not
   APFS.
2. **Runs the real backend**: `reflinkFile` → `cloneFile` → `copyfile(3)` with
   `COPYFILE_ALL | COPYFILE_CLONE_FORCE` through `bun:ffi`. Not an injected
   syscall.
3. **Measures shared extents** with `fcntl(fd, F_LOG2PHYS_EXT)` physical block
   mapping and compares the source's and clone's block sets (Jaccard overlap
   ≈ 1.0). `du`/`st_blocks` **cannot** be used: APFS double-counts clones, so a
   genuine clone reads as a full copy there. The syscall runs in the
   `scripts/verify-apfs/log2phys.py` helper (the stdlib `fcntl` module, a child
   process), **not** through `bun:ffi`: Darwin's `fcntl` is variadic and a
   fixed-arity `bun:ffi` binding works on x86_64 but segfaults the whole Bun
   process on arm64, taking the report with it. If the helper is unavailable
   or the kernel refuses, the job falls back to a `df` free-space delta (≈0
   growth around the clone) and **labels the evidence with the method used**.
4. **Confirms copy-on-write** by mutating one byte in the clone: the source
   must be byte-unchanged and the mutated block must move to a new device
   offset (or the volume must grow, under the fallback). A hardlink would
   change the source; a clean overlap of 1.0 alone cannot tell them apart.
5. **Fails loudly** on `ENOTSUP`/`EXDEV`, on a non-APFS volume, and on an
   overlap that shows a byte copy. `--require` also turns a clean "wrong
   platform" skip into a failure, so a skip can never masquerade as a pass. The
   job is **not** `continue-on-error`.

The full evidence is printed to the job log and uploaded as the
`apfs-verification-<runner>` artifact. The report is written on **every** exit
path — including a skip and an unexpected exception — to `${{ runner.temp }}`,
and the upload uses `always()` with `if-no-files-found: warn`. That guarantee
was added after the first real run: an uncaught `execFileSync` throw meant the
script wrote nothing, and the upload step then failed with "No files were found
with the provided path". A failing verification no longer costs its own
evidence. `macos-15-intel` is a one-off cross-check on a distinct image and
architecture; drop it when `macos-15` retires in Fall 2027.

### The arm64 `fcntl` fault (why the measurement is a `python3` helper)

Earlier revisions bound `fcntl` through `bun:ffi` as a fixed-arity function.
Darwin's `fcntl` is variadic, and `bun:ffi` cannot express varargs. On x86_64
that mismatch is invisible — the third argument lands where the callee reads it
— so `macos-15-intel` produced correct evidence. On arm64 (AAPCS64) the
anonymous argument is read from the stack instead, so the kernel dereferenced
garbage: `macos-latest` panicked with `Segmentation fault at address
0xF9BC600000000008` (exit 139) **before writing its report**. The fault
surfaced during exception unwinding, so a `try`/`catch` around the FFI call
could not have recovered the process or the artifact.

The first fix deleted the `bun:ffi` `fcntl` binding and moved the call into
`scripts/verify-apfs/log2phys.py` using Python `ctypes`. That was **not
enough**: `ctypes` cannot express varargs either, and with `argtypes` unset
CPython treats `fcntl` as fixed-arity (it reaches `ffi_prep_cif_var` only when
`argtypes` is set and shorter than the supplied argument list). On Apple arm64
libffi gates the variadic register/stack split on `aarch64_nfixedargs`, which
the fixed-arity path leaves `0`; all three arguments go in `x0/x1/x2` while the
variadic callee `va_arg`s a stack slot that was never written. The run no
longer segfaulted, but `macos-latest` reported `F_LOG2PHYS_EXT unavailable:
log2phys helper exited 5: ... EFAULT (errno 14)` and fell back to the weaker
`df-delta` method. `macos-15-intel` was unaffected — x86_64 System V passes
fixed and variadic arguments identically.

The correct fix is the stdlib `fcntl` module. `fcntl.fcntl(fd,
F_LOG2PHYS_EXT, packed_bytes)` issues the call from C compiled against the real
`int fcntl(int, int, ...)` prototype, so the anonymous argument lands wherever
the kernel's `va_arg` reads it on every architecture. It still runs in a
**child process**, so a bad ABI or a kernel refusal surfaces as a non-zero exit
that `extents.ts` converts into an `ExtentReadError` — the process running the
verification, and the report it writes in its `finally`, are never at risk. The
call is arch-independent, so **both matrix legs run the strong measurement**.
The helper is a `python3` dependency; every GitHub-hosted macOS image ships
`/usr/bin/python3`, and an interpreter that is missing becomes the labelled
`df` fallback rather than an error.

### What the job does **not** prove

- **It does not close #7 by itself.** The acceptance bar is "CI emits measured
  shared-extent evidence and a human approves it". A human still reads the
  artifact and signs off. A green run is the evidence, not the approval.
- It does not attest to an arbitrary user's Mac — only to that runner image's
  macOS version and one APFS volume.
- It does not cover cross-volume clones, which correctly return `EXDEV`.
- The overlap is a sampled ratio at `st_blksize` granularity, not an exhaustive
  extent walk. Sampling is deterministic across both files, so a byte copy
  still reads ≈0 and a real clone ≈1.0.

### Running it locally

On Linux (or any non-macOS machine) the script **skips cleanly** (exit 0) with a
named reason:

```sh
bun run scripts/verify-apfs/verify-apfs.ts
```

On a Mac, run it without `--require` to get the evidence without converting a
skip into a failure:

```sh
bun run scripts/verify-apfs/verify-apfs.ts --report=/tmp/apfs.txt
```

## What CI does **not** prove

- The Darwin `copyfile(3)` backend against a real APFS filesystem **in the
  `macos` job**. Its logic is tested there with an injected syscall; the real
  syscall path is not run. The `apfs-verification` job *does* run it and
  measures shared extents, but a human still approves that evidence before #7
  closes. A green `macos` job is an early warning and nothing more.
- The full CoW path end to end. The e2e harness
  (`scripts/e2e/`) is not run in CI at all.
- The **positive** CoW path on the Linux runner. A GitHub-hosted Linux runner
  has no copy-on-write filesystem, so those tests skip there. The CoW clone is
  proven on a CoW-capable machine (this project's btrfs host) and, on macOS, by
  `apfs-verification`.

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
| GitHub macOS runner (`macos` job) | skip (no CoW fs) | skip if no non-CoW fs found | run |
| GitHub macOS runner (`apfs-verification` job) | n/a — the dedicated APFS script runs the real Darwin clone and measures extents | n/a | `scripts/verify-apfs/logic.test.ts` and `scripts/verify-apfs/log2phys.test.ts` run as part of `bun test` on every job |
| ext4 developer laptop | skip (no CoW fs) | run (tmpfs or ext4) | run |

On this project's btrfs machine the positive path runs for real — the tests do
not silently skip here. On a runner they skip cleanly rather than fail for an
environmental reason. A skip on a runner is visible in the log, so a green job
never pretends the CoW clone ran when it did not.

### Residual environment assumptions

- `df -Pk` is used for two things: resolving the scratch directory's mount
  point (for `diskutil info`) and measuring free-space deltas. `-P` forces the
  POSIX column layout on macOS *and* GNU/Linux (`Filesystem 1024-blocks Used
  Available Capacity Mounted on`), so the same indices parse on both. GNU `df
  -P` may wrap a long device name onto its own line and repeat
  `Filesystem 1024-blocks ...` in the first column; the parser reads the last
  line, whose first field is a real device (`/dev/...`). A first field without
  a `/` is rejected rather than mistaken for a device.
- `test/clone.test.ts` drives `btrfs filesystem du` for the extent-sharing
  test. A CoW filesystem need not be btrfs, so that test additionally requires
  btrfs-progs on PATH against the discovered root; it skips when either is
  absent (`canMeasureBtrfsExtents`).
- Tests that build scratch git repositories require `git` on PATH and skip via
  `hasGit()` when it is missing.
- The `apfs-verification` extent measurement requires `python3` on PATH (the
  `log2phys.py` helper; `COW_LOG2PHYS_PYTHON` overrides the binary). The
  GitHub-hosted macOS images ship `/usr/bin/python3`; a missing interpreter is
  not fatal — it becomes a labelled `df` fallback rather than a failure.
- `/dev/shm` size is not an assumption: the negative tests write a small
  scratch tree only.

## Lockfile

There is no `bun.lock`/`bun.lockb` committed. CI resolves dependencies fresh
(`bun install`). If a lockfile is added, the workflow already switches to
`bun install --frozen-lockfile` via its existence check. Adding a lockfile is a
reasonable follow-up; it is not required for CI to work.

## APFS verification artifacts

`apfs-verification` uploads one artifact per runner,
`apfs-verification-<runner>` (e.g. `apfs-verification-macos-latest`). Each
contains the full raw evidence: `diskutil info`, the macOS version, `df -Pk`,
the sampled physical block counts, the Jaccard overlap, the mutation result, and
the final `VERDICT`. The report path is
`${{ runner.temp }}/apfs-verification-<runner>.txt` and the upload uses
`if: always()`, so a failing run still preserves its measurement for review;
`if-no-files-found` is `warn` rather than `error` so a genuinely missing report
cannot mask the verification step's own failure. The script itself writes the
report on every exit path. Approving that artifact is the human step that closes
#7.
