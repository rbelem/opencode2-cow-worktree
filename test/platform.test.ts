import { afterEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneFile, cloneOnLinux, isDarwin } from "../src/platform";
import type { PlatformCheck } from "../src/platform";
import { cloneDirectory, reflinkFile } from "../src/clone";
import { findCowRoot, findNonCowRoot } from "./fs-roots";

// Discover the roots instead of hardcoding this machine's mounts. The
// real-filesystem tests are gated on `linux` and on a discovered root; the
// dispatch and Darwin-logic tests run anywhere.
const cowRoot = await findCowRoot();
const nonCowRoot = await findNonCowRoot();
const onLinux = process.platform === "linux";

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(root: string = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(root, "cow-platform-"));
  scratchDirs.push(dir);
  return dir;
}

// --- platform selection ---------------------------------------------------

test("isDarwin agrees with process.platform", () => {
  expect(isDarwin()).toBe(process.platform === "darwin");
});

test.skipIf(cowRoot === undefined)("cloneFile takes the Linux branch when the platform check says Linux", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  const target = join(dir, "target");
  await writeFile(source, "same bytes\n");

  // A platform check that never selects Darwin. If the dispatch took the
  // Darwin path, the real `bun:ffi` `dlopen("/usr/lib/libSystem.B.dylib")`
  // would run and fail on this machine.
  const notDarwin: PlatformCheck = () => false;
  await cloneFile(source, target, notDarwin);

  expect(await readFile(target, "utf8")).toBe("same bytes\n");
});

test.skipIf(!onLinux || cowRoot === undefined)("cloneFile on Linux is byte-identical to the raw forced reflink", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  await writeFile(source, "identical clone\n");

  await cloneFile(source, join(dir, "platform"));
  await copyFile(source, join(dir, "raw"), constants.COPYFILE_FICLONE_FORCE);

  expect(await readFile(join(dir, "platform"))).toEqual(await readFile(join(dir, "raw")));
});

test.skipIf(!onLinux || cowRoot === undefined)("reflinkFile is the platform operation: it clones real bytes on btrfs", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  const target = join(dir, "target");
  await writeFile(source, "reflinked\n");

  await reflinkFile(source, target);
  expect(await readFile(target, "utf8")).toBe("reflinked\n");
});

// --- Linux path: real btrfs clone, real tmpfs failure ---------------------

test.skipIf(!onLinux || cowRoot === undefined)("cloneFile clones a file on a CoW filesystem", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  const target = join(dir, "target");
  await writeFile(source, "btrfs clone\n");

  await cloneFile(source, target);

  expect(await readFile(target, "utf8")).toBe("btrfs clone\n");
});

test.skipIf(!onLinux || nonCowRoot === undefined)("cloneFile fails loudly on a filesystem without CoW support", async () => {
  const dir = await scratch(nonCowRoot!);
  const source = join(dir, "source");
  const target = join(dir, "target");
  await writeFile(source, "cannot clone\n");

  const error = await cloneOnLinux(source, target).then(
    () => undefined,
    (failure: unknown) => failure as { code?: string },
  );

  expect(error).toBeDefined();
  expect(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]).toContain(error?.code ?? "");
  // Fail loud, not silently: no full copy was left behind.
  await expect(readFile(target)).rejects.toThrow();
});

test.skipIf(!onLinux || cowRoot === undefined)("cloneDirectory over the platform path is unchanged on Linux", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  await (await import("node:fs/promises")).mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "a.txt"), "a\n");
  await writeFile(join(source, "nested", "b.txt"), "b\n");

  await cloneDirectory(source, join(dir, "clone"));

  expect(await readFile(join(dir, "clone", "a.txt"), "utf8")).toBe("a\n");
  expect(await readFile(join(dir, "clone", "nested", "b.txt"), "utf8")).toBe("b\n");
});

test.skipIf(!onLinux || cowRoot === undefined)("cloneOnLinux refuses an existing destination file instead of overwriting it", async () => {
  // Darwin parity: `COPYFILE_CLONE_FORCE` implies `COPYFILE_EXCL` there (see
  // `platform-darwin.ts`), so the Linux `copyFile` must carry the flag
  // explicitly — belt and suspenders under `cloneDirectory`'s entry guard,
  // and correct on its own: the walker only ever writes fresh names, so an
  // occupied destination is a bug to surface, not bytes to replace.
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  const target = join(dir, "target");
  await writeFile(source, "clone bytes\n");
  await writeFile(target, "destination bytes\n");

  const error = await cloneOnLinux(source, target).then(
    () => undefined,
    (failure: unknown) => failure as { code?: string },
  );

  expect(error?.code).toBe("EEXIST");
  // The refusal is not an overwrite in disguise.
  expect(await readFile(target, "utf8")).toBe("destination bytes\n");
  // The operation is unchanged where it belongs: a fresh target still clones.
  await cloneOnLinux(source, join(dir, "fresh"));
  expect(await readFile(join(dir, "fresh"), "utf8")).toBe("clone bytes\n");
});

// --- Darwin dispatch is inert on Linux ------------------------------------

test.skipIf(!onLinux || cowRoot === undefined)("cloneFile with no override takes the Linux branch on this machine", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  await writeFile(source, "linux only\n");

  // The default platform check is process.platform-based. `isDarwin()` is the
  // seam's ground truth here; the dispatch must follow it on Linux.
  expect(isDarwin()).toBe(false);
  await cloneFile(source, join(dir, "target"));
  expect(await readFile(join(dir, "target"), "utf8")).toBe("linux only\n");
});

test.skipIf(!onLinux || cowRoot === undefined)("the Darwin branch is unreachable on Linux even when forced", async () => {
  const dir = await scratch(cowRoot!);
  const source = join(dir, "source");
  await writeFile(source, "x\n");
  const alwaysDarwin: PlatformCheck = () => true;

  // Forcing the Darwin branch on Linux must fail (bun:ffi cannot load
  // libSystem.B.dylib), never silently produce a copy. This is the seam's
  // fail-closed property, asserted where it can actually run.
  const error = await cloneFile(source, join(dir, "target"), alwaysDarwin).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error).toBeInstanceOf(Error);
  await expect(readFile(join(dir, "target"))).rejects.toThrow();
});

// --- the injected syscall seam accepts a fake -----------------------------

test("cloneFileOnDarwin accepts an injected syscall so its logic is testable", async () => {
  const { cloneFileOnDarwin } = await import("../src/platform-darwin");
  const calls: string[] = [];
  const fake = async (source: string, destination: string) => {
    calls.push(`${source}->${destination}`);
    return { cloned: true };
  };

  await cloneFileOnDarwin("/src/a", "/dst/a", fake);
  expect(calls).toEqual(["/src/a->/dst/a"]);
});

test("cloneFileOnDarwin rejects a non-clone result and removes the target", async () => {
  const { cloneFileOnDarwin } = await import("../src/platform-darwin");
  const dir = await scratch();
  const target = join(dir, "target");
  // Simulate the syscall having written a full copy before reporting it did
  // not clone.
  const handler = async () => {
    await writeFile(target, "full copy\n");
    return { cloned: false };
  };

  const error = await cloneFileOnDarwin(join(dir, "source"), target, handler).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error?.message).toMatch(/refusing a full copy/);
  // Fail closed: the silent full copy is discarded.
  await expect(readFile(target)).rejects.toThrow();
});

test.skipIf(process.platform !== "linux")(
  "bun:ffi returns the raw C failure without throwing or setting .code",
  async () => {
    // The design fact the Darwin FFI binding is built on: bun:ffi does not raise
    // a C error into JavaScript. If this ever changes, the binding's explicit
    // errno read would become dead code. Asserted against Linux libc, because
    // this is the only place the behavior can run.
    const { dlopen } = (await import("bun:ffi")) as typeof import("bun:ffi");
    const lib = dlopen("libc.so.6", {
      open: { args: ["cstring", "i32"], returns: "i32" },
    }) as { symbols: { open: (path: string, flags: number) => number } };

    const result = lib.symbols.open("/nonexistent/cow-probe", 0);
    expect(result).toBe(-1);
  },
);
