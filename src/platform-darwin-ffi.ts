/**
 * The real macOS `copyfile(3)` binding, isolated from the decision logic in
 * `platform-darwin.ts`.
 *
 * On Darwin the load succeeds; on Linux `dlopen` fails and the failure
 * propagates as an error, because `platform.ts` never selects this module
 * there. Nothing in this file runs on Linux.
 *
 * LIMITATIONS, stated plainly because this code cannot be executed here:
 *
 * - `bun:ffi` does not throw on a failing C call and does not populate
 *   `.code`; it returns the raw result and leaves `errno` for the caller. The
 *   errno must therefore be read explicitly through `__error()` and mapped to a
 *   name. (This behavior was confirmed locally against `libc.so.6`: a failing
 *   `open(2)` returned `-1` with no thrown error and no `.code`.)
 * - `COPYFILE_STATE_WAS_CLONED` is a *state* query, not a return bit. With
 *   `COPYFILE_CLONE_FORCE`, a 0 return already means the clone happened (the
 *   flag fails rather than falls back), so no state handle is needed.
 * - None of this is verified against a real `copyfile(3)`; that requires a
 *   human on real APFS hardware.
 */
import { dlopen, FFIType, read } from "bun:ffi";
import { DARWIN_CLONE_FLAGS } from "./platform-darwin";
import type { DarwinCloneSyscall } from "./platform-darwin";

interface CopyfileLibrary {
  readonly copyfile: (
    source: string,
    destination: string,
    state: null,
    flags: number,
  ) => number;
  readonly __error: () => number;
}

// Held for the process lifetime on purpose. `copyfile` is called through a
// small libc trampoline; `dlclose`-ing libSystem while that trampoline is still
// mapped would be a use-after-free, and a plugin process is long-lived anyway.
const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
  copyfile: { args: ["cstring", "cstring", "ptr", "u32"], returns: "i32" },
  // Darwin's errno accessor (XNU bsd/sys/errno.h: `#define errno (*__error())`).
  __error: { args: [], returns: FFIType.ptr },
}) as { symbols: CopyfileLibrary };

/**
 * Darwin errno numbers relevant to a clone. The header is XNU
 * `bsd/sys/errno.h`; unmapped numbers become `ERRNO_<n>` so a code is always
 * present and a real failure never looks like a missing one.
 */
const ERRNO_NAMES: Readonly<Record<number, string>> = {
  1: "EPERM",
  2: "ENOENT",
  5: "EIO",
  13: "EACCES",
  17: "EEXIST",
  18: "EXDEV",
  20: "ENOTDIR",
  22: "EINVAL",
  25: "ENOTTY",
  28: "ENOSPC",
  30: "EROFS",
  45: "ENOTSUP",
  62: "ELOOP",
  63: "ENAMETOOLONG",
  78: "ENOSYS",
};

function errnoCode(): string {
  const errno = read.i32(symbols.__error());
  return ERRNO_NAMES[errno] ?? `ERRNO_${errno}`;
}

/**
 * Clones one regular file with `copyfile(3)`, or throws an `Error` carrying the
 * Darwin errno name in `.code`. The capability predicate matches on those
 * names, so `ENOTSUP` (an unsupported filesystem) is classified without the
 * probe ever seeing the raw syscall.
 */
export const darwinSyscall: DarwinCloneSyscall = async (source, destination) => {
  if (symbols.copyfile(source, destination, null, DARWIN_CLONE_FLAGS) === 0) {
    return { cloned: true };
  }
  const error = new Error(
    `copyfile(3) failed on ${source} -> ${destination}`,
  ) as Error & { code: string };
  error.code = errnoCode();
  throw error;
};
