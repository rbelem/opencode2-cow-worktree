import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { probeCowCapability, type CowCloneAttempt } from "../src/capability";

// The unsupported branch is produced by substituting the clone operation
// (CowCloneAttempt) — the only filesystem operation the predicate performs. A
// non-CoW filesystem cannot be mounted reliably without root, so stubbing the
// clone operation is the portable choice; the supported branch keeps a real
// filesystem test at the bottom.

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const failedAttempt =
  (code: string): CowCloneAttempt =>
  async () => {
    throw codedError(code);
  };

const NOT_SUPPORTED = ["EOPNOTSUPP", "ENOTSUP", "EINVAL", "EXDEV", "ENOSYS"];
const UNEXPECTED = ["EACCES", "ENOENT", "EIO", "EPERM"];

function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cow-capability-"));
}

for (const code of NOT_SUPPORTED) {
  test(`reports unsupported when the clone fails with ${code}`, async () => {
    const dir = await scratchDir();
    try {
      const result = await probeCowCapability(dir, failedAttempt(code));
      expect(result).toEqual({ status: "unsupported" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const code of UNEXPECTED) {
  test(`reports an error when the clone fails with ${code}`, async () => {
    const dir = await scratchDir();
    try {
      const result = await probeCowCapability(dir, failedAttempt(code));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toHaveProperty("code", code);
      }
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("reports an error, without throwing, for a missing directory", async () => {
  const parent = await scratchDir();
  try {
    const result = await probeCowCapability(join(parent, "missing"));
    expect(result.status).toBe("error");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("caches per source directory without changing the answer", async () => {
  const dir = await scratchDir();
  try {
    let calls = 0;
    const attempt: CowCloneAttempt = async () => {
      calls += 1;
    };
    const first = await probeCowCapability(dir, attempt);
    const second = await probeCowCapability(dir, attempt);
    expect(first).toEqual({ status: "supported" });
    expect(second).toEqual({ status: "supported" });
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- supported branch, against a real copy-on-write filesystem ---

/** Independent ground truth: does a raw forced clone work in `dir`? */
async function cloneSucceeds(dir: string): Promise<boolean> {
  let scratch: string;
  try {
    scratch = await mkdtemp(join(dir, "cow-capability-ground-truth-"));
  } catch {
    return false;
  }
  try {
    const source = join(scratch, "source");
    await writeFile(source, "x");
    await copyFile(
      source,
      join(scratch, "clone"),
      constants.COPYFILE_FICLONE_FORCE,
    );
    return true;
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function findCowBase(): Promise<string | undefined> {
  for (const base of [homedir(), tmpdir(), process.cwd()]) {
    if (await cloneSucceeds(base)) return base;
  }
  return undefined;
}

const cowBase = await findCowBase();

test.skipIf(cowBase === undefined)(
  "reports supported on a copy-on-write filesystem",
  async () => {
    const dir = await mkdtemp(join(cowBase!, "supported-"));
    try {
      expect(await probeCowCapability(dir)).toEqual({ status: "supported" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
