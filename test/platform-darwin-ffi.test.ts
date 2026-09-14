import { afterEach, beforeEach, expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import { DARWIN_CLONE_FLAGS } from "../src/platform-darwin";
import {
  createDarwinSyscall,
  loadCopyfileLibrary,
  resetCopyfileLibrary,
} from "../src/platform-darwin-ffi";
import type { CopyfileLibrary, LibraryLoad } from "../src/platform-darwin-ffi";

// These tests run on Linux because the module is inert on import: only calling
// `loadCopyfileLibrary()` would touch libSystem. The real `dlopen` cannot run
// here, so the loader is injected. The errno is read with bun:ffi's
// `read.i32`, so the fake `__error` must return a real pointer over an int;
// `ptr(new Int32Array([...]))` supplies one without loading any library. No
// `bun:ffi` module is mocked.

// The injected loaders must not leak into later test files: the module cache
// is process-lifetime, so a fake left behind would make a forced-Darwin call
// succeed on Linux somewhere else in the suite.
afterEach(() => {
  resetCopyfileLibrary();
});

// The leak-guard is not enough on its own: bun test's file order is not
// alphabetical, and on macOS an earlier file can exercise the real darwin
// backend, populating the process-lifetime cache through the real dlopen.
// Starting every test here from an empty cache is what makes the injected
// loader observable and the "loads once" pin honest regardless of what ran
// before this file.
beforeEach(() => {
  resetCopyfileLibrary();
});

test("loadCopyfileLibrary loads libSystem once and returns the same binding", () => {
  const symbols: CopyfileLibrary = {
    copyfile: () => 0,
    __error: () => 0,
  };
  const paths: string[] = [];
  const load: LibraryLoad = (path, definitions) => {
    paths.push(path);
    // The FFI signature is the risky constant in this module: a typo'd
    // arg/return spec would compile and then call the C function wrongly. The
    // expected shape is written out literally rather than imported, so the
    // assertion cannot recompute itself from the production object.
    expect(definitions).toEqual({
      copyfile: { args: ["cstring", "cstring", "ptr", "u32"], returns: "i32" },
      __error: { args: [], returns: 12 },
    });
    return { symbols };
  };

  const first = loadCopyfileLibrary(load);
  // A second resolution must reuse the binding rather than `dlopen` again:
  // `cloneFileOnDarwin` resolves the syscall per cloned file.
  const second = loadCopyfileLibrary(load);

  expect(paths).toEqual(["/usr/lib/libSystem.B.dylib"]);
  // Identity: the FFI loader's `symbols` object is what the syscall binds to.
  expect(first).toBe(symbols);
  expect(second).toBe(symbols);
});

test("createDarwinSyscall clones when copyfile returns 0", async () => {
  const calls: Array<[string, string, null, number]> = [];
  const symbols: CopyfileLibrary = {
    copyfile: (source, destination, state, flags) => {
      calls.push([source, destination, state, flags]);
      return 0;
    },
    __error: () => 0,
  };

  const outcome = await createDarwinSyscall(symbols)("/src/a", "/dst/a");

  expect(outcome).toEqual({ cloned: true });
  expect(calls).toEqual([["/src/a", "/dst/a", null, DARWIN_CLONE_FLAGS]]);
});

test("createDarwinSyscall names the errno: 13 maps to EACCES", async () => {
  // 13 is EACCES in XNU's bsd/sys/errno.h. The expected name is written out as
  // a literal so the test does not recompute it from the production table.
  const errno = new Int32Array([13]);
  const symbols: CopyfileLibrary = {
    copyfile: () => -1,
    __error: () => ptr(errno),
  };

  const error = await createDarwinSyscall(symbols)("/src/a", "/dst/a").then(
    () => undefined,
    (failure: unknown) => failure as Error & { code?: string },
  );

  expect(error?.code).toBe("EACCES");
  expect(error?.message).toContain("/src/a");
  expect(error?.message).toContain("/dst/a");
});

test("createDarwinSyscall falls back to ERRNO_<n> for an unmapped errno", async () => {
  const errno = new Int32Array([999]);
  const symbols: CopyfileLibrary = {
    copyfile: () => -1,
    __error: () => ptr(errno),
  };

  const error = await createDarwinSyscall(symbols)("/src/a", "/dst/a").then(
    () => undefined,
    (failure: unknown) => failure as Error & { code?: string },
  );

  expect(error?.code).toBe("ERRNO_999");
});
