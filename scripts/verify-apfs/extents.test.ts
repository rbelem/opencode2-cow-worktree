/**
 * Unit coverage for `extents.ts` that is not Darwin-specific.
 *
 * `physicalMappingAt` and `samplePhysicalBlocks` normally shell out to
 * `python3 log2phys.py`, which only measures on a Mac. `COW_LOG2PHYS_PYTHON` is
 * the module's documented interpreter override, so pointing it at a shell
 * fixture drives the whole subprocess path — argv contract, stdout parsing,
 * and the failure classifier — on any platform.
 */
import { expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtentReadError,
  blockStride,
  classifyHelperFailure,
  physicalMappingAt,
  samplePhysicalBlocks,
} from "./extents";

// --- classifyHelperFailure ------------------------------------------------

test("a string thrown value keeps the default helper code and message", () => {
  expect(classifyHelperFailure("boom")).toEqual({
    code: "EHELPER",
    message: "could not run the log2phys helper: boom",
  });
});

test("a Buffer stderr is decoded and its first errno wins", () => {
  expect(classifyHelperFailure({ stderr: Buffer.from("ENOTSUP: nope\n") })).toEqual({
    code: "ENOTSUP",
    message: "could not run the log2phys helper: ENOTSUP: nope",
  });
});

test("a non-zero exit without an errno names the status", () => {
  expect(classifyHelperFailure({ status: 2, stderr: "" })).toEqual({
    code: "EHELPER2",
    message: "log2phys helper exited 2",
  });
});

test("a killed child names the signal", () => {
  expect(classifyHelperFailure({ signal: "SIGKILL", stderr: "" })).toEqual({
    code: "ESIGNAL_SIGKILL",
    message: "log2phys helper killed by SIGKILL",
  });
});

test("a spawn failure falls back to the spawn code", () => {
  expect(classifyHelperFailure({ code: "ENOENT", stderr: "" })).toEqual({
    code: "ENOENT",
    message: "could not run the log2phys helper",
  });
});

test("an empty thrown object lands on the generic default", () => {
  expect(classifyHelperFailure({})).toEqual({
    code: "EHELPER",
    message: "could not run the log2phys helper",
  });
});

// --- blockStride ----------------------------------------------------------

test("blockStride reads the real filesystem block size", () => {
  const dir = mkdtempSync(join(tmpdir(), "cow-extents-"));
  try {
    const file = join(dir, "probe");
    writeFileSync(file, "x");
    expect(blockStride(file)).toBeGreaterThan(0);
    expect(blockStride(file)).toBe(statSync(file).blksize);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blockStride falls back to 4096 when the filesystem reports zero", () => {
  expect(blockStride("/irrelevant", () => ({ blksize: 0 }))).toBe(4096);
});

// --- subprocess paths via the interpreter override ------------------------

let fixtureDir: string;
let originalPython: string | undefined;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "cow-fixture-"));
  // Other test files read the same var, so capture it and restore it even if a
  // test throws.
  originalPython = process.env.COW_LOG2PHYS_PYTHON;
});

afterEach(() => {
  if (originalPython === undefined) {
    delete process.env.COW_LOG2PHYS_PYTHON;
  } else {
    process.env.COW_LOG2PHYS_PYTHON = originalPython;
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Writes an executable `sh` interpreter fixture and points the module at it. */
function useFixture(body: string): void {
  const script = join(fixtureDir, "fake-python");
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  process.env.COW_LOG2PHYS_PYTHON = script;
}

/** A real file so `physicalMappingAt`/`samplePhysicalBlocks` can stat it. */
function probeFile(): string {
  const file = join(fixtureDir, "probe.bin");
  writeFileSync(file, "0123456789");
  return file;
}

test("physicalMappingAt returns the first parsed mapping", async () => {
  // `printf` (not `echo`) so the tabs are real tab bytes, as the helper emits.
  useFixture("#!/bin/sh\nprintf '0\\t12345\\t4096\\n'\n");
  const file = probeFile();
  const mapping = await physicalMappingAt(file, 0, 4096);
  expect(mapping.deviceOffset).toBe(12345n);
  expect(mapping.contiguousBytes).toBe(4096n);
});

test("samplePhysicalBlocks collects distinct offsets and the file size", async () => {
  useFixture("#!/bin/sh\nprintf '0\\t111\\t4096\\n4096\\t222\\t4096\\n'\n");
  const file = probeFile();
  const map = await samplePhysicalBlocks(file);
  expect(map.offsets).toEqual(new Set([111n, 222n]));
  expect(map.samples).toBe(2);
  expect(map.fileSize).toBe(statSync(file).size);
});

test("physicalMappingAt rejects with EPROTO when the helper emits no mapping", async () => {
  useFixture("#!/bin/sh\nprintf '\\n\\n'\n");
  const file = probeFile();
  let failure: unknown;
  try {
    await physicalMappingAt(file, 0, 4096);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ExtentReadError);
  expect((failure as ExtentReadError).code).toBe("EPROTO");
});

test("physicalMappingAt surfaces a helper errno as the error code", async () => {
  useFixture("#!/bin/sh\necho 'ENOTSUP: no clone' >&2\nexit 2\n");
  const file = probeFile();
  let failure: unknown;
  try {
    await physicalMappingAt(file, 0, 4096);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ExtentReadError);
  expect((failure as ExtentReadError).code).toBe("ENOTSUP");
});
