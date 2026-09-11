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

## Verification on real APFS hardware (open)

The ticket's acceptance criterion is a human on real APFS hardware pasting
output. On an Apple Silicon Mac with Bun 1.4.x:

```sh
# 1. Confirm the runtime is Bun (the backend depends on bun:ffi).
opencode2 --version
bun --version

# 2. Capability predicate: must report supported on APFS, unsupported on tmpfs.
bun -e '
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCowCapability } from "./src/capability";
const apfs = await mkdtemp(join(process.env.HOME, ".cow-probe-"));
console.log("APFS  :", await probeCowCapability(apfs));
console.log("tmpfs :", await probeCowCapability("/tmp"));
'

# 3. Real clone + shared extents. On APFS a clone's `du` should be a small
#    fraction of the file size; a full copy reports the full size. Also print
#    `st_blocks` (512-byte units) for source and clone.
bun -e '
import { execFileSync } from "node:child_process";
import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { reflinkFile, cloneDirectory } from "./src/clone";
const dir = await mkdtemp(join(process.env.HOME, ".cow-clone-"));
await writeFile(join(dir, "src"), randomBytes(64 * 1024 * 1024));
await reflinkFile(join(dir, "src"), join(dir, "clone"));
console.log(execFileSync("du", ["-h", dir], { encoding: "utf8" }));
const s = await stat(join(dir, "src"));
const c = await stat(join(dir, "clone"));
console.log("src blocks:", s.blocks, "clone blocks:", c.blocks);
await cloneDirectory(dir, join(dir, "deep"));
console.log("deep clone ok:", execFileSync("ls", [join(dir, "deep")], { encoding: "utf8" }));
await rm(dir, { recursive: true, force: true });
'
```

Paste the full output on issue #7. A green CI run does not substitute for it.

## Consequences

- The platform seam (`cloneFile`, `isDarwin`) dispatches by OS. On Linux the
  macOS module is never imported, so the backend is inert there.
- The Darwin decision logic is unit-tested with an injected syscall. The real
  `copyfile(3)` binding cannot be exercised on this machine.
- **Nothing here is verified on real APFS hardware.** That is the ticket's
  acceptance criterion and is still open. Green CI does not close it.

## References

- Apple `copyfile.h`: <https://github.com/apple-oss-distributions/copyfile>
- `copyfile(3)` man page:
  <https://keith.github.io/xcode-man-pages/copyfile.3.html>
- XNU `bsd/sys/errno.h` (`__error`, `ENOTSUP` = 45 on Darwin)
- Issue #7 research comment (libuv history, Bun behavior)
