# 0002 — macOS backend: `copyfile(3)` with `COPYFILE_CLONE_FORCE` on a Bun runtime

Status: accepted

## Context

The Linux clone is a per-file reflink (`COPYFILE_FICLONE_FORCE`). On macOS that
call is not portable across runtimes:

- Under **Node**, `COPYFILE_FICLONE_FORCE` throws `ENOSYS` unconditionally,
  including on APFS, because libuv has no `copyfile(3)`/`clonefile(2)` path on
  Darwin (removed in v1.28.0, re-added in 2023, reverted before v1.45.0; Node
  18–24 vendor the reverted libuv).
- Under **Bun**, the same call reaches `clonefile(2)` and produces real APFS
  clones for regular files.

The ticket asks for the intended macOS runtime to be decided and recorded before
implementing, because the answer decides whether a backend primitive is needed
at all.

## Decision

**Runtime: Bun.** The plugin is loaded by the opencode2 server, and the server
is a Bun binary.

Evidence, from the installed `opencode2` binary
(`opencode2 v0.0.0-next-20260910`, Nix store, 279.8 MB):

- Embedded runtime string `Bun v1.4.0 (34cbb9a40) Linux x64`.
- 1694 occurrences of `JavaScriptCore`/`JSC::` and zero occurrences of
  `V8 version`/`v8::Isolate`; the only `v8` symbols seen are from a bundled
  dependency (browserslist), not the runtime.
- Bun feature strings (`Bun/${Bun.version}`, `bun-hmr`, `bun build v`).

**Primitive: `copyfile(3)` with `COPYFILE_ALL | COPYFILE_CLONE_FORCE`,
called through `bun:ffi`.**

`clonefile(2)` on a directory is not used: Apple discourages it (it blocks the
whole tree for the duration of the call), so the Deep clone stays a per-entry
walk in `cloneDirectory`, and `copyfile(3)` is invoked once per regular file.

Even though Bun's reflink already reaches `clonefile(2)`, `copyfile(3)` is
chosen because it is the ticket's named recursive primitive, and it exposes the
metadata flags (`COPYFILE_ACL`, `COPYFILE_XATTR`, setuid behavior) that the
policy questions below are about. Relying on Bun's reflink would leave those
implicit and dependent on Bun's libuv-equivalent behavior.

## Policy decisions

- **ACLs are cloned.** `COPYFILE_ALL` is `COPYFILE_ACL | COPYFILE_STAT |
  COPYFILE_XATTR | COPYFILE_DATA`, so Apple's precondition ("ACLs will not be
  cloned unless `COPYFILE_ACL` is also passed") is satisfied.
- **setuid/setgid are not copied.** Apple's `copyfile(3)` does not copy them
  unless `COPYFILE_STATE_PRESERVE_SUID` is set; it is not set, matching the
  Linux reflink behavior of dropping them.
- **Extended attributes are cloned** via `COPYFILE_ALL`.
- **Sparse files.** `COPYFILE_DATA_SPARSE` is not set, so a sparse source is
  materialized densely; a later write inside the clone cannot hit the
  `ENOSPC`-on-later-write hazard that sparse cloning can create on an
  under-provisioned volume.
- **Hard links are not preserved.** The recursive clone recreates each link as a
  regular cloned file, exactly as the Linux path documents in #3. Consistent,
  not a regression.
- **`COPYFILE_EXCL` is implied** by the clone flag, so the destination must not
  exist. The caller's walker already satisfies this.

## Failure semantics

Fail closed, twice:

1. `COPYFILE_CLONE_FORCE` fails rather than falling back to a byte copy on an
   unsupported filesystem or a cross-volume target. The errno propagates.
2. `cloneFileOnDarwin` also rejects a syscall result that reports success
   without a real clone, removes the target, and throws. A Deep clone that
   quietly became a full copy is never returned as success.

The capability predicate shares the same operation, so on macOS it does not
probe with `COPYFILE_FICLONE_FORCE` and never answers `unsupported` on APFS.

## Verification on real APFS hardware

The ticket's acceptance criterion is a human approving evidence of a real APFS
clone with genuinely shared extents. That evidence is now produced by a CI job —
`apfs-verification` in `.github/workflows/ci.yml` — which runs on a
GitHub-hosted macOS runner:

1. **The volume is asserted to be APFS** via `diskutil info` on the scratch
   directory's **mount point** (macOS has no `df -T`). `diskutil info` accepts a
   device node or a mount point, not an arbitrary subdirectory — passing the
   scratch dir directly yields `Could not find disk`, which the job's first real
   run proved. The mount point is resolved from `df -Pk`; the `mount(8)`
   filesystem type is a labelled fallback if `diskutil` gives no personality. No
   official GitHub document states the runner volume's filesystem, so the job
   proves it at runtime before trusting anything else, and fails loudly if it is
   not APFS.
2. **The real backend runs**: `reflinkFile` → `cloneFile` → `copyfile(3)` with
   `COPYFILE_ALL | COPYFILE_CLONE_FORCE` through `bun:ffi`. Not an injected
   syscall — the actual Darwin code path.
3. **Shared extents are measured**, not inferred from a clean exit. The job
   samples the source's and clone's physical block maps with
   `fcntl(fd, F_LOG2PHYS_EXT)` and compares them (Jaccard overlap ≈ 1.0). This
   is required because `du`/`st_blocks` **double-count clones on APFS** — there
   is no `btrfs filesystem du` equivalent — so a clone looks like a full copy in
   those numbers. `ls -la` link counts are meaningless here. The syscall runs in
   the `scripts/verify-apfs/log2phys.py` helper (Python `ctypes`, a child
   process), **not** through `bun:ffi` — see "The varargs ABI hazard" below.
   If the helper is unavailable or `F_LOG2PHYS_EXT` is refused, the job falls
   back to a `df` free-space delta around the clone (≈0 growth), and **says so
   in the output and the artifact**; the method is never left implicit.
4. **Copy-on-write is confirmed** by mutating one byte in the clone and
   re-measuring: the source must be byte-unchanged and the mutated block must
   move to a new device offset (or the volume must grow, under the fallback). A
   hardlink would change the source; a stale/byte copy would not have moved the
   block. A clean overlap of 1.0 alone cannot distinguish a clone from a
   hardlink, which is why this step is required.
5. **Fail loud**: `ENOTSUP`/`EXDEV`, a non-APFS volume, or an overlap that shows
   a byte copy all fail the job. The CI invocation passes `--require`, which
   converts even a clean "wrong platform" skip into a failure, so a skip can
   never masquerade as a pass. The job is not `continue-on-error`.

The evidence — `diskutil` output, macOS version, `df`, the sampled block counts,
the overlap ratio, and the mutation result — is printed to the job log and
uploaded as the `apfs-verification-<runner>` artifact. The report is written on
**every** exit path (including a skip and an unexpected exception) to
`${{ runner.temp }}`, and the upload runs with `always()` and
`if-no-files-found: warn`, so a failing verification still leaves its evidence
for review instead of failing the upload step too.

**A green CI run does not close #7 by itself.** The acceptance bar is "CI emits
measured shared-extent evidence for a real APFS clone, and a human approves that
evidence". The remaining human step is to read the uploaded artifact and confirm
the verdict; there is no longer a need for a human to own a Mac and paste
terminal output.

The same script runs on Linux and **skips cleanly** (exit 0, a named reason)
without `--require`, so a developer without a Mac can invoke it. Run it locally
on a Mac as:

```sh
bun run scripts/verify-apfs/verify-apfs.ts --report=/tmp/apfs.txt
```

### The varargs ABI hazard (`fd → F_LOG2PHYS_EXT`)

The extent measurement originally reached `fcntl` through `bun:ffi`, the same
mechanism as the backend under test — a fixed-arity binding:

```ts
fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" }
```

That is wrong in a way that is invisible on one architecture and fatal on the
other. Darwin's `fcntl` is **variadic** (`bsd/sys/fcntl.h`:
`int fcntl(int, int, ...) __DARWIN_ALIAS_C(fcntl);`) and **`bun:ffi` cannot
express varargs** — `FFIFunction.args` is fixed-arity. The consequences differ
by ABI:

- **x86_64 (System V):** fixed and variadic arguments are passed in the same
  registers, so the fixed-arity binding accidentally works. The
  `macos-15-intel` leg produced correct Intel evidence (`method:
  F_LOG2PHYS_EXT`, `overlap (Jaccard) = 1.000000`, `mutation: source
  changed=false block moved=true`).
- **arm64 (AAPCS64):** anonymous arguments are placed on the stack, so the
  kernel's `va_arg(ap, void *)` read a garbage pointer.
  `macos-latest` (arm64) died with `panic(main thread): Segmentation fault at
  address 0xF9BC600000000008` / exit 139, **before writing its report**. The
  fault surfaced during JSC exception unwinding after the bad call, so no
  `try`/`catch` around the FFI call could have saved the process or the
  artifact.

The control experiment is in the same job's logs: `copyfile` — fixed-arity and
correctly declared — is bound from the *same* `dlopen` and works on arm64,
while `fcntl` faults. The struct layout (20 bytes, `#pragma pack(4)`), the
constant `F_LOG2PHYS_EXT = 65`, the `i32` command width, and the `Buffer`-as-
`ptr` marshalling were all verified correct and were **not** the bug.

**The fix removes `fcntl` from `bun:ffi` entirely.** `log2phys.py` makes the
identical call via Python `ctypes` in a **child process**. `ctypes` also cannot
declare varargs, but it does not need to: the call executes in that child's C
runtime, so a bad ABI or a kernel refusal kills the helper and becomes a
non-zero exit code (`log2phys` exits 3 off-Darwin, 5 on kernel refusal, 2 on
usage error) that `extents.ts` turns into an `ExtentReadError`. The
verification process itself can no longer fault at the FFI boundary. This is
arch-independent, so **both matrix legs run the strong measurement**.

This is a genuinely useful lesson beyond this repo: a fixed-arity `bun:ffi`
binding to a variadic libc function is silently wrong on x86_64 and
segmenting on arm64. The reproduction is recorded here rather than filed
upstream.

### Caveats that genuinely remain

- **First executed on a macOS runner on 2026-09-11, and it failed.** The first
  failure was in the APFS assertion, before the backend was reached:
  `diskutil info` was handed the scratch *subdirectory*, which is not a disk,
  and returned `Could not find disk:
  /Users/runner/work/_temp/cow-apfs-XXXX`; the uncaught `execFileSync` throw
  then lost the evidence file entirely, so the `upload-artifact` step reported
  "No files were found". Both the invocation (now the `df`-resolved mount
  point) and the report guarantee (written on every exit path) are fixed.
  The **second** failure was the arm64 `fcntl` fault described above; moving
  the call to `log2phys.py` removes the ABI hazard, but the fix itself has not
  yet run on a real runner. Everything past the platform check still has not
  been observed to work on a real runner.
- **`F_LOG2PHYS_EXT` is assumed to be accepted by APFS.** The constant (65) and
  the 20-byte `#pragma pack(4)` `struct log2phys` are confirmed against XNU
  `bsd/sys/fcntl.h`, but `F_LOG2PHYS` was historically HFS-oriented and kernel
  acceptance on APFS has still not been observed. The `ctypes` prototype
  passes the struct by pointer with `use_errno=True`, so an `EINVAL`/`ENOTTY`
  from the kernel becomes a clear helper exit rather than a fault. A refusal
  falls back to the labelled `df`-delta method and prints the errno loudly; it
  is not treated as success.
- **The helper adds a `python3` dependency.** The GitHub-hosted macOS images
  ship `/usr/bin/python3`. If it is absent, `execFileSync` throws `ENOENT`,
  which becomes an `ExtentReadError` and a labelled `df-delta` fallback; the
  evidence says the helper could not be run. On Linux, the helper exits 3 and
  the same fallback applies, but the verification job skips before then.
- A green run attests to **that runner image's macOS version and one APFS
  volume**. It cannot attest to an arbitrary user's machine.
- **Cross-volume clones are not covered** and correctly return `EXDEV`; the
  runner's scratch and clone are on the same volume by construction.
- `F_LOG2PHYS_EXT` samples at the file's `st_blksize` granularity; the reported
  overlap is a sampled ratio, not an exhaustive extent walk. The sampling is
  deterministic (same logical offsets in both files), so a byte copy still
  reads ≈0 and a clone ≈1.0.
- Intel support ends when `macos-15` retires in Fall 2027; the primary target is
  `macos-latest` (macOS 26 arm64).

## Consequences

- The platform seam (`cloneFile`, `isDarwin`) dispatches by OS. On Linux the
  macOS module is never imported, so the backend is inert there.
- The Darwin decision logic is unit-tested with an injected syscall. The real
  `copyfile(3)` binding is exercised by the `apfs-verification` CI job on a
  macOS runner, which measures shared extents.
- The extent measurement does not share the `bun:ffi` binding style of the
  backend: the backend's `copyfile` is fixed-arity and safe, but any future
  variadic libc call must go through `log2phys.py`-style `ctypes` rather than a
  fixed-arity `bun:ffi` prototype.
- **Nothing here is verified on real APFS hardware until that job runs.** That
  is the ticket's acceptance criterion; the job produces the evidence and a
  human approves it. A green run alone does not close #7.

## References

- Apple `copyfile.h`: <https://github.com/apple-oss-distributions/copyfile>
- `copyfile(3)` man page:
  <https://keith.github.io/xcode-man-pages/copyfile.3.html>
- XNU `bsd/sys/errno.h` (`__error`, `ENOTSUP` = 45 on Darwin)
- XNU `bsd/sys/fcntl.h` (`F_LOG2PHYS_EXT` = 65, `struct log2phys`, and the
  variadic `int fcntl(int, int, ...)` prototype)
- `scripts/verify-apfs/log2phys.py` — the `ctypes` helper the fix moved the
  call into
- Issue #7 research comment (libuv history, Bun behavior)
- `scripts/verify-apfs/` — the CI evidence job for the acceptance criterion
