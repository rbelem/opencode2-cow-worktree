import { expect, test } from "bun:test";
import {
  MAX_CLONE_GROWTH_RATIO,
  MIN_MUTATION_GROWTH_BYTES,
  MIN_OVERLAP,
  evaluateCowMutation,
  evaluateExtentSharing,
  jaccardOverlap,
  parseDfPk,
  parseFilesystemPersonality,
  parseOptions,
} from "./logic";

// These tests run anywhere, including the Linux CI runner. They exercise the
// verdict logic — the difference between "ran without error" and "shared
// extents" — without touching Darwin syscalls. The real measurement runs only
// on a macOS runner (scripts/verify-apfs/verify-apfs.ts).

// --- APFS assertion -------------------------------------------------------

const DISKUTIL_APFS = `   Device Identifier:         disk3s5
   Mount Point:               /System/Volumes/Data
   Partition Type:            Apple_APFS
   File System Personality:   APFS
   Type (Bundle):             apfs
   Name (User Visible):       APFS`;

test("parseFilesystemPersonality reads APFS from diskutil output", () => {
  expect(parseFilesystemPersonality(DISKUTIL_APFS)).toBe("APFS");
});

test("parseFilesystemPersonality returns undefined when the field is absent", () => {
  expect(parseFilesystemPersonality("   Device Identifier: disk1\n")).toBeUndefined();
});

// --- df parsing -----------------------------------------------------------

test("parseDfPk reads used and available KiB from the data line", () => {
  const output = [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/disk3s5     971350180 123456789  45678901    73%   /System/Volumes/Data",
    "",
  ].join("\n");
  expect(parseDfPk(output)).toEqual({ usedKb: 123456789, availableKb: 45678901 });
});

test("parseDfPk tolerates thousands separators and returns undefined on junk", () => {
  expect(parseDfPk("Filesystem K-blocks Used Avail Mounted\n/dev/x 1,000 2,000 3,000  /")).toEqual({
    usedKb: 2000,
    availableKb: 3000,
  });
  expect(parseDfPk("not a df line")).toBeUndefined();
});

// --- overlap --------------------------------------------------------------

test("jaccardOverlap is 1.0 for identical block sets and 0 for disjoint ones", () => {
  expect(jaccardOverlap(new Set([1n, 2n, 3n]), new Set([1n, 2n, 3n]))).toBe(1);
  expect(jaccardOverlap(new Set([1n, 2n]), new Set([3n, 4n]))).toBe(0);
});

test("jaccardOverlap is intersection over union for partial sharing", () => {
  expect(jaccardOverlap(new Set([1n, 2n]), new Set([2n, 3n]))).toBeCloseTo(1 / 3, 10);
});

test("jaccardOverlap treats two empty sets as no evidence", () => {
  expect(jaccardOverlap(new Set(), new Set())).toBe(0);
});

// --- parsing options ------------------------------------------------------

test("parseOptions defaults to a non-required local run", () => {
  expect(parseOptions([])).toEqual({
    requireApfs: false,
    reportPath: "apfs-verification.txt",
    sizeMib: 64,
    dir: undefined,
  });
});

test("parseOptions honours --require and the value flags", () => {
  const options = parseOptions([
    "--require",
    "--report=evidence.txt",
    "--size-mib=128",
    "--dir=/tmp/scratch",
  ]);
  expect(options).toEqual({
    requireApfs: true,
    reportPath: "evidence.txt",
    sizeMib: 128,
    dir: "/tmp/scratch",
  });
});

test("parseOptions ignores a non-positive size", () => {
  expect(parseOptions(["--size-mib=0"]).sizeMib).toBe(64);
});

// --- shared-extent verdict ------------------------------------------------

test("a genuine block-equal clone passes", () => {
  const result = evaluateExtentSharing({
    method: "F_LOG2PHYS_EXT",
    overlap: 1,
    cloneGrowthBytes: 0,
    fileSizeBytes: 64 * 1024 * 1024,
  });
  expect(result.ok).toBe(true);
  expect(result.failures).toEqual([]);
});

test("an overlap below the sharing threshold fails, not just warns", () => {
  const result = evaluateExtentSharing({
    method: "F_LOG2PHYS_EXT",
    overlap: 0.4,
    cloneGrowthBytes: 0,
    fileSizeBytes: 64 * 1024 * 1024,
  });
  expect(result.ok).toBe(false);
  expect(MIN_OVERLAP).toBeLessThanOrEqual(1);
  expect(result.failures.join(" ")).toMatch(/overlap/);
});

test("growth under the df fallback passes only when it is far below the file size", () => {
  const fileSizeBytes = 64 * 1024 * 1024;
  const shared = evaluateExtentSharing({
    method: "df-delta",
    overlap: undefined,
    cloneGrowthBytes: 0,
    fileSizeBytes,
  });
  expect(shared.ok).toBe(true);

  const copied = evaluateExtentSharing({
    method: "df-delta",
    overlap: undefined,
    cloneGrowthBytes: fileSizeBytes,
    fileSizeBytes,
  });
  expect(copied.ok).toBe(false);
  expect(MAX_CLONE_GROWTH_RATIO).toBeLessThan(1);
});

// --- copy-on-write mutation verdict ---------------------------------------

test("a mutation that changes the source is a hardlink, not a clone", () => {
  const result = evaluateCowMutation({
    method: "F_LOG2PHYS_EXT",
    mutatedBlockMoved: true,
    sourceByteChanged: true,
    mutationGrowthBytes: 0,
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join(" ")).toMatch(/hardlink/);
});

test("a mutation that does not move the block is not copy-on-write", () => {
  const result = evaluateCowMutation({
    method: "F_LOG2PHYS_EXT",
    mutatedBlockMoved: false,
    sourceByteChanged: false,
    mutationGrowthBytes: 0,
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join(" ")).toMatch(/did not change/);
});

test("a mutation that moves the block and leaves the source alone passes", () => {
  const result = evaluateCowMutation({
    method: "F_LOG2PHYS_EXT",
    mutatedBlockMoved: true,
    sourceByteChanged: false,
    mutationGrowthBytes: 0,
  });
  expect(result.ok).toBe(true);
});

test("under df-delta, no growth after mutation fails", () => {
  const result = evaluateCowMutation({
    method: "df-delta",
    mutatedBlockMoved: false,
    sourceByteChanged: false,
    mutationGrowthBytes: 0,
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join(" ")).toMatch(/grew the volume/);
});

test("under df-delta, a block-sized growth after mutation passes", () => {
  const result = evaluateCowMutation({
    method: "df-delta",
    mutatedBlockMoved: false,
    sourceByteChanged: false,
    mutationGrowthBytes: MIN_MUTATION_GROWTH_BYTES,
  });
  expect(result.ok).toBe(true);
});
