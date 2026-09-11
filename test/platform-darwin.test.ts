import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneFileOnDarwin, COPYFILE_ALL, COPYFILE_CLONE_FORCE, COPYFILE_EXCL, DARWIN_CLONE_FLAGS } from "../src/platform-darwin";
import type { CloneOutcome, DarwinCloneSyscall } from "../src/platform-darwin";

// These tests exercise the macOS backend's *logic* with an injected fake
// syscall. No test here runs Darwin code natively, and none proves the real
// syscall's behaviour: that requires a human on real APFS hardware. The tests
// are platform-independent — the fake syscall needs no CoW filesystem.
const OUTCOME_ROOT = tmpdir();

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(OUTCOME_ROOT, "cow-darwin-"));
  scratchDirs.push(dir);
  return dir;
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Records calls and returns a scripted outcome. */
function fakeSyscall(
  outcome: CloneOutcome = { cloned: true },
  before?: (destination: string) => Promise<void>,
): { syscall: DarwinCloneSyscall; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const syscall: DarwinCloneSyscall = async (source, destination) => {
    calls.push([source, destination]);
    if (before) await before(destination);
    return outcome;
  };
  return { syscall, calls };
}

// --- flags ----------------------------------------------------------------

test("the clone flags are COPYFILE_ALL | COPYFILE_CLONE_FORCE", () => {
  // Fail-loud cloning is required; metadata would otherwise be dropped, which
  // would lose the executable bit git reads.
  expect(DARWIN_CLONE_FLAGS).toBe(COPYFILE_ALL | COPYFILE_CLONE_FORCE);
  expect(DARWIN_CLONE_FLAGS & COPYFILE_CLONE_FORCE).toBe(COPYFILE_CLONE_FORCE);
  expect(DARWIN_CLONE_FLAGS & COPYFILE_ALL).toBe(COPYFILE_ALL);
});

test("COPYFILE_EXCL is implied by the clone flag, not OR'd in separately", () => {
  // Named for documentation: the clone flag's semantics already include EXCL,
  // so it is not part of the mask. The destination must not exist.
  expect(DARWIN_CLONE_FLAGS & COPYFILE_EXCL).toBe(0);
});

test("ACLs are cloned because COPYFILE_ALL carries COPYFILE_ACL (1<<0)", () => {
  // Apple's header: COPYFILE_ALL = ACL|STAT|XATTR|DATA, and "ACLs will not be
  // cloned unless COPYFILE_ACL is also passed". COPYFILE_ALL satisfies that.
  expect(DARWIN_CLONE_FLAGS & (1 << 0)).toBe(1 << 0);
});

// --- success path ---------------------------------------------------------

test("passes the source and destination to the syscall and resolves on a clone", async () => {
  const { syscall, calls } = fakeSyscall();
  await cloneFileOnDarwin("/repo/a.txt", "/clone/a.txt", syscall);
  expect(calls).toEqual([["/repo/a.txt", "/clone/a.txt"]]);
});

// --- fail-closed: a silent fallback is rejected ---------------------------

test("rejects a silent-fallback result and removes the destination", async () => {
  const dir = await scratch();
  const destination = join(dir, "a.txt");
  const { syscall } = fakeSyscall({ cloned: false }, async (path) => {
    // The syscall wrote a full byte copy but did not clone.
    await writeFile(path, "a full copy, not a clone\n");
  });

  const error = await cloneFileOnDarwin(join(dir, "source"), destination, syscall).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error?.message).toMatch(/refusing a full copy/);
  // Fail closed: the target must not survive as a plausible-looking clone.
  await expect(readFile(destination)).rejects.toThrow();
});

test("removing a nonexistent destination on the fail-closed path is not an error", async () => {
  const dir = await scratch();
  const { syscall } = fakeSyscall({ cloned: false });

  // No file was written; the cleanup must still succeed and the failure must
  // remain the clone refusal, not an ENOENT from cleanup.
  const error = await cloneFileOnDarwin(join(dir, "source"), join(dir, "missing"), syscall).then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );

  expect(error?.message).toMatch(/refusing a full copy/);
});

// --- errno propagation: EXDEV is the caller's unsupported signal ----------

test("propagates the raw syscall error so the probe can classify ENOTSUP", async () => {
  const failing: DarwinCloneSyscall = async () => {
    throw codedError("ENOTSUP");
  };

  const error = await cloneFileOnDarwin("/a", "/b", failing).then(
    () => undefined,
    (failure: unknown) => failure as { code?: string },
  );

  expect(error?.code).toBe("ENOTSUP");
});

test("propagates EXDEV unchanged: a cross-volume clone is the unsupported signal", async () => {
  const failing: DarwinCloneSyscall = async () => {
    throw codedError("EXDEV");
  };

  const error = await cloneFileOnDarwin("/a", "/b", failing).then(
    () => undefined,
    (failure: unknown) => failure as { code?: string },
  );

  expect(error?.code).toBe("EXDEV");
});

test("propagates EEXIST unchanged: COPYFILE_CLONE_FORCE implies COPYFILE_EXCL", async () => {
  // The clone flag implies EXCL, so an existing destination fails instead of
  // being overwritten. The caller's walker never targets an existing file, so
  // the error is passed through as an unexpected failure, not swallowed.
  const existingDestination: DarwinCloneSyscall = async () => {
    throw codedError("EEXIST");
  };

  const error = await cloneFileOnDarwin("/a", "/b", existingDestination).then(
    () => undefined,
    (failure: unknown) => failure as { code?: string },
  );

  expect(error?.code).toBe("EEXIST");
});

test("does not treat an unexpected errno as an unsupported filesystem", async () => {
  // EIO is not a capability answer; the backend must not decide otherwise.
  const failing: DarwinCloneSyscall = async () => {
    throw codedError("EIO");
  };

  const error = await cloneFileOnDarwin("/a", "/b", failing).then(
    () => undefined,
    (failure: unknown) => failure as { code?: string },
  );

  expect(error?.code).toBe("EIO");
});
