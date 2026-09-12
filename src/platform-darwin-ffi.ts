/**
 * The real macOS `copyfile(3)` binding, isolated from the decision logic in
 * `platform-darwin.ts`.
 *
 * This module is inert on import: importing `bun:ffi` is fine on Linux, and
 * nothing here calls `dlopen`. The library is loaded only when
 * `loadCopyfileLibrary()` is called, which happens only when a Darwin process
 * actually selects this backend. On Linux that call fails, because
 * `/usr/lib/libSystem.B.dylib` does not exist.
 *
 * LIMITATIONS, stated plainly because the real `copyfile(3)` cannot be executed
 * here (only the loader seam can be exercised):
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

/** The `copyfile(3)` / `__error(3)` entry points this binding needs. */
export interface CopyfileLibrary {
  readonly copyfile: (
    source: string,
    destination: string,
    state: null,
    flags: number,
  ) => number;
  readonly __error: () => number;
}

/**
 * The loader seam, modelled on `dlopen` itself so the real call is exercised by
 * a test with a recording stand-in.
 */
export type LibraryLoad = (
  path: string,
  definitions: unknown,
) => { readonly symbols: unknown };

/**
 * The `bun:ffi` definition for libSystem's `copyfile` and its errno accessor
 * (XNU bsd/sys/errno.h: `#define errno (*__error())`).
 */
const COPYFILE_DEFINITION = {
  copyfile: { args: ["cstring", "cstring", "ptr", "u32"], returns: "i32" },
  __error: { args: [], returns: FFIType.ptr },
} as const;

/**
 * The resolved binding, held for the process lifetime. `cloneFileOnDarwin`
 * resolves the syscall per file, so without this cache `dlopen` would run on
 * every cloned file. libSystem is a loaded image rather than a library that is
 * opened, so this is not a correctness issue — but the handle is also never
 * `dlclose`d on purpose, because `copyfile` is called through a small libc
 * trampoline and unloading libSystem while it is still mapped would be a
 * use-after-free. Caching states that intent instead of leaving it to the
 * refcount.
 */
let loaded: CopyfileLibrary | undefined;

/**
 * Loads the macOS `copyfile(3)` binding out of libSystem, once per process.
 *
 * The `load` seam defaults to the real `dlopen`, so production code loads the
 * library while a test can inject a recording stand-in and inspect the exact
 * call.
 */
export function loadCopyfileLibrary(
  load: LibraryLoad = dlopen as unknown as LibraryLoad,
): CopyfileLibrary {
  loaded ??= load("/usr/lib/libSystem.B.dylib", COPYFILE_DEFINITION).symbols as CopyfileLibrary;
  return loaded;
}

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

function errnoCode(symbols: CopyfileLibrary): string {
  const errno = read.i32(symbols.__error());
  return ERRNO_NAMES[errno] ?? `ERRNO_${errno}`;
}

/**
 * Builds the syscall over an already-loaded library. Clones one regular file
 * with `copyfile(3)`, or throws an `Error` carrying the Darwin errno name in
 * `.code`. The capability predicate matches on those names, so `ENOTSUP` (an
 * unsupported filesystem) is classified without the probe ever seeing the raw
 * syscall.
 */
export function createDarwinSyscall(
  symbols: CopyfileLibrary,
): DarwinCloneSyscall {
  return async (source, destination) => {
    if (symbols.copyfile(source, destination, null, DARWIN_CLONE_FLAGS) === 0) {
      return { cloned: true };
    }
    const error = new Error(
      `copyfile(3) failed on ${source} -> ${destination}`,
    ) as Error & { code: string };
    error.code = errnoCode(symbols);
    throw error;
  };
}
