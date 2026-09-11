/**
 * The `log2phys.py` helper and the `extents.ts` wrapper that parses it.
 *
 * These run on Linux: `F_LOG2PHYS_EXT` is a Darwin/HFS-APFS `fcntl`, so the
 * helper must refuse cleanly here instead of throwing. What is proven on Linux
 * is the part that is *not* Darwin-specific — the argument contract, the
 * non-Darwin guard, and the stdout parser — so the macOS runner is the only
 * place a real device offset is ever needed.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ExtentReadError, parseLog2Phys } from "./extents";

const HELPER = fileURLToPath(new URL("./log2phys.py", import.meta.url));
const PYTHON = process.env.COW_LOG2PHYS_PYTHON ?? "python3";

interface HelperRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runHelper(args: readonly string[]): HelperRun {
  try {
    const stdout = execFileSync(PYTHON, [HELPER, ...args], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const record = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: record.status ?? -1,
      stdout: record.stdout ?? "",
      stderr: record.stderr ?? "",
    };
  }
}

// --- stdout parser --------------------------------------------------------

test("parseLog2Phys reads offset/device/contiguous tab fields", () => {
  const samples = parseLog2Phys("0\t4096\t4096\n4096\t16384\t4096\n");
  expect(samples).toEqual([
    { offset: 0n, deviceOffset: 4096n, contiguousBytes: 4096n },
    { offset: 4096n, deviceOffset: 16384n, contiguousBytes: 4096n },
  ]);
});

test("parseLog2Phys ignores blank lines and tolerates a missing contiguous field", () => {
  expect(parseLog2Phys("\n0\t8192\n\n")).toEqual([
    { offset: 0n, deviceOffset: 8192n, contiguousBytes: 0n },
  ]);
});

test("parseLog2Phys rejects a line without a tab (the helper contract is strict)", () => {
  expect(() => parseLog2Phys("not a sample\n")).toThrow(ExtentReadError);
});

test("parseLog2Phys rejects a non-numeric field rather than guessing", () => {
  expect(() => parseLog2Phys("0\tNaN\t4096\n")).toThrow(ExtentReadError);
});

// --- helper argument contract (platform-independent) ----------------------

test("the helper refuses to run without --stride", () => {
  const result = runHelper(["/tmp/nonexistent-probe"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/--stride/);
});

test("the helper rejects a non-integer --stride", () => {
  const result = runHelper(["/tmp/nonexistent-probe", "--stride=abc"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/integer/);
});

test("the helper rejects an unknown option", () => {
  const result = runHelper(["/tmp/nonexistent-probe", "--stride=4096", "--wat"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/unknown option/);
});

// --- non-Darwin guard -----------------------------------------------------

test("on a non-Darwin platform the helper exits 3 with a clear message, not an error", () => {
  if (process.platform === "darwin") return; // covered by the CI macOS leg
  const result = runHelper(["/tmp/nonexistent-probe", "--stride=4096"]);
  expect(result.status).toBe(3);
  expect(result.stderr).toMatch(/F_LOG2PHYS_EXT is a Darwin/);
  expect(result.stderr).toMatch(new RegExp(process.platform));
});
