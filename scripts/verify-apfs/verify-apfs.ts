#!/usr/bin/env bun
/**
 * macOS APFS clone verification — the evidence job for issue #7.
 *
 * This script runs the plugin's **real** Darwin backend (`reflinkFile` →
 * `copyfile(3)` with `COPYFILE_CLONE_FORCE` via `bun:ffi`) on a real APFS
 * volume, then proves the clone genuinely shares physical extents:
 *
 *   1. assert the volume is APFS (`diskutil info`, not `df -T` — macOS has no
 *      `df -T`) and print the raw mount facts;
 *   2. clone a block of bytes through the real backend;
 *   3. measure shared extents with `fcntl(fd, F_LOG2PHYS_EXT)` physical block
 *      mapping (Jaccard overlap ≈ 1.0). `df` free-space delta is the labelled
 *      fallback when `F_LOG2PHYS_EXT` is impractical, because `du`/`st_blocks`
 *      double-count clones on APFS and link counts say nothing about CoW;
 *   4. mutate one byte in the clone; the source must be untouched and the
 *      mutated block must move to a new device offset (or the volume must grow
 *      under the fallback), which is what distinguishes a CoW clone from a
 *      hardlink;
 *   5. print the raw evidence and write it to a report for CI to upload.
 *
 * Weak evidence — "the clone code path ran without error" — is explicitly not
 * enough. The job fails loudly on `ENOTSUP`/`EXDEV`, on a non-APFS volume, and
 * on a measured overlap that shows a byte copy. `--require` turns a clean local
 * skip into a hard failure so a skip can never masquerade as a pass on CI.
 *
 * Runs on Linux too: without `--require` it skips cleanly with a clear reason so
 * a developer without a Mac can invoke it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateCowMutation,
  evaluateExtentSharing,
  jaccardOverlap,
  parseDfPk,
  parseFilesystemPersonality,
  parseOptions,
} from "./logic";
import type { Evaluation, ExtentMethod, VerifyOptions } from "./logic";
import type { PhysicalBlockMap } from "./extents";

type Reporter = (line: string) => void;
type ExtentsModule = typeof import("./extents");
type Df = { readonly usedKb: number; readonly availableKb: number };

/** Below this many samples per file, `F_LOG2PHYS_EXT` cannot answer usefully. */
const MIN_SAMPLES = 16;

interface ExtentMeasurement {
  readonly method: ExtentMethod;
  readonly overlap: number | undefined;
  readonly cloneGrowthBytes: number;
  readonly module: ExtentsModule | undefined;
  readonly sourceMap: PhysicalBlockMap | undefined;
  readonly stride: number;
}

interface MutationResult {
  readonly mutatedBlockMoved: boolean;
  readonly sourceByteChanged: boolean;
  readonly mutationGrowthBytes: number;
  readonly overlapAfter: number | undefined;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const report: string[] = [];
  const say: Reporter = (line) => {
    report.push(line);
    console.log(line);
  };

  say("== opencode2-cow-worktree · macOS APFS clone verification ==");
  say(`platform=${process.platform} arch=${process.arch} bun=${Bun.version}`);

  const code = await verify(options, say);
  writeReport(options.reportPath, report);
  return code;
}

async function verify(options: VerifyOptions, say: Reporter): Promise<number> {
  if (process.platform !== "darwin") {
    say(`SKIPPED: this machine is ${process.platform}, not darwin.`);
    say("The Darwin copyfile(3)/bun:ffi backend and APFS extents cannot be exercised here.");
    say("Run this on macOS for #7 acceptance evidence; CI runs it with --require.");
    return options.requireApfs ? 1 : 0;
  }

  const autoCreated = options.dir === undefined;
  const dir = options.dir ?? mkdtempSync(join(scratchBase(), "cow-apfs-"));
  try {
    return await verifyOnApfs(options, dir, say);
  } finally {
    if (autoCreated) rmSync(dir, { recursive: true, force: true });
  }
}

async function verifyOnApfs(options: VerifyOptions, dir: string, say: Reporter): Promise<number> {
  say(`scratch: ${dir}`);
  if (!checkApfs(dir, say)) return 1;
  logEnvironment(dir, say);

  const source = join(dir, "source.bin");
  const clone = join(dir, "clone.bin");
  const sizeBytes = options.sizeMib * 1024 * 1024;
  writeFileSync(source, payload(sizeBytes));
  say(`wrote ${sizeBytes} B probe file`);

  const dfBeforeClone = readDf(dir);
  const cloneFailure = await tryClone(source, clone, say);
  if (cloneFailure !== undefined) return cloneFailure;
  const dfAfterClone = readDf(dir);

  const measurement = await measureExtents(source, clone, dfBeforeClone, dfAfterClone, say);
  const sharing = evaluateExtentSharing({
    method: measurement.method,
    overlap: measurement.overlap,
    cloneGrowthBytes: measurement.cloneGrowthBytes,
    fileSizeBytes: sizeBytes,
  });
  const mutation = mutateAndVerify(dir, source, clone, measurement, sizeBytes, dfAfterClone, say);
  const cow = evaluateCowMutation({
    method: measurement.method,
    mutatedBlockMoved: mutation.mutatedBlockMoved,
    sourceByteChanged: mutation.sourceByteChanged,
    mutationGrowthBytes: mutation.mutationGrowthBytes,
  });

  return reportVerdict(measurement, mutation, sharing, cow, say);
}

/** Asserts the scratch volume is APFS, printing the raw `diskutil` output. */
function checkApfs(dir: string, say: Reporter): boolean {
  const diskutil = execFileSync("diskutil", ["info", dir], { encoding: "utf8" });
  say("--- diskutil info <scratch> ---");
  say(diskutil.trimEnd());
  const personality = parseFilesystemPersonality(diskutil);
  if ((personality ?? "").toUpperCase() !== "APFS") {
    say("");
    say(`FATAL: the volume under ${dir} is not APFS (personality: ${personality ?? "unknown"}).`);
    say("This job exists only to prove APFS shared-extent cloning and cannot pass here.");
    return false;
  }
  say(`APFS confirmed: ${personality}`);
  return true;
}

function logEnvironment(dir: string, say: Reporter): void {
  say(`macOS ${tryRun("sw_vers", ["-productVersion"]) ?? "unknown"} (${tryRun("uname", ["-m"]) ?? "unknown"})`);
  say("--- df -Pk <scratch> ---");
  say(run("df", ["-Pk", dir]).trimEnd());
}

/** Runs the plugin's real clone operation; returns a failure code or undefined. */
async function tryClone(source: string, clone: string, say: Reporter): Promise<number | undefined> {
  try {
    const { reflinkFile } = await import("../../src/clone");
    await reflinkFile(source, clone);
    return undefined;
  } catch (error) {
    say("");
    say("FATAL: the plugin's real clone operation did not produce a clone.");
    say(`error: ${error instanceof Error ? error.message : String(error)}`);
    const code = errorCode(error);
    if (code !== undefined) say(`darwin errno: ${code}`);
    say("A fallback byte copy is never accepted as issue #7 evidence.");
    return 1;
  }
}

/**
 * Attempts the `F_LOG2PHYS_EXT` block map first; falls back to the `df`
 * free-space delta and labels the evidence with whichever method produced it.
 */
async function measureExtents(
  source: string,
  clone: string,
  dfBefore: Df,
  dfAfter: Df,
  say: Reporter,
): Promise<ExtentMeasurement> {
  const cloneGrowthBytes = growthBytes(dfBefore, dfAfter);
  say(`df clone growth = ${cloneGrowthBytes} B`);

  try {
    const module = await import("./extents");
    const sourceMap = module.samplePhysicalBlocks(source);
    const cloneMap = module.samplePhysicalBlocks(clone);
    if (sourceMap.samples < MIN_SAMPLES || cloneMap.samples < MIN_SAMPLES) {
      throw new Error(
        `only ${sourceMap.samples}/${cloneMap.samples} physical samples; too coarse to be meaningful`,
      );
    }
    const overlap = jaccardOverlap(sourceMap.offsets, cloneMap.offsets);
    say("--- F_LOG2PHYS_EXT physical block maps ---");
    say(
      `stride=${sourceMap.stride} B samples=${sourceMap.samples} ` +
        `source distinct device offsets=${sourceMap.offsets.size} clone=${cloneMap.offsets.size}`,
    );
    say(`overlap (Jaccard) = ${overlap.toFixed(6)}`);
    return {
      method: "F_LOG2PHYS_EXT",
      overlap,
      cloneGrowthBytes,
      module,
      sourceMap,
      stride: sourceMap.stride,
    };
  } catch (error) {
    say("");
    say(`F_LOG2PHYS_EXT unavailable: ${error instanceof Error ? error.message : String(error)}`);
    say(`errno code: ${errorCode(error) ?? "none"}`);
    say("Falling back to the df free-space delta; the evidence is labelled with the method used.");
    return { method: "df-delta", overlap: undefined, cloneGrowthBytes, module: undefined, sourceMap: undefined, stride: 4096 };
  }
}

/** Mutates one byte in the clone and re-measures, proving copy-on-write. */
function mutateAndVerify(
  dir: string,
  source: string,
  clone: string,
  measurement: ExtentMeasurement,
  sizeBytes: number,
  dfAfterClone: Df,
  say: Reporter,
): MutationResult {
  const offset = alignedOffset(sizeBytes, measurement.stride);
  const useBlocks = measurement.method === "F_LOG2PHYS_EXT" && measurement.module !== undefined;
  const mappingBefore = useBlocks
    ? deviceOffsetAt(measurement.module!, clone, offset, measurement.stride)
    : undefined;

  const sourceBefore = readByteAt(source, offset);
  writeByteAt(clone, offset, sourceBefore ^ 0xff);
  const sourceAfter = readByteAt(source, offset);

  const mappingAfter = useBlocks
    ? deviceOffsetAt(measurement.module!, clone, offset, measurement.stride)
    : undefined;

  let overlapAfter: number | undefined;
  if (useBlocks && measurement.sourceMap !== undefined) {
    overlapAfter = jaccardOverlap(
      measurement.sourceMap.offsets,
      measurement.module!.samplePhysicalBlocks(clone).offsets,
    );
  }

  const mutationGrowthBytes = growthBytes(dfAfterClone, readDf(dir));
  say(`mutated one byte at logical offset ${offset}`);
  say(
    `mutation: source changed=${sourceAfter !== sourceBefore} ` +
      `block moved=${mappingBefore !== undefined && mappingAfter !== mappingBefore} ` +
      `df growth=${mutationGrowthBytes} B`,
  );
  if (overlapAfter !== undefined && measurement.overlap !== undefined) {
    say(`overlap after mutation = ${overlapAfter.toFixed(6)} (before ${measurement.overlap.toFixed(6)})`);
  }

  return {
    mutatedBlockMoved: mappingBefore !== undefined && mappingAfter !== mappingBefore,
    sourceByteChanged: sourceAfter !== sourceBefore,
    mutationGrowthBytes,
    overlapAfter,
  };
}

function reportVerdict(
  measurement: ExtentMeasurement,
  mutation: MutationResult,
  sharing: Evaluation,
  cow: Evaluation,
  say: Reporter,
): number {
  const failures = [...sharing.failures, ...cow.failures];
  say("");
  say(`method: ${measurement.method}`);
  say(`clone df growth: ${measurement.cloneGrowthBytes} B`);
  say(`mutation df growth: ${mutation.mutationGrowthBytes} B`);
  if (failures.length > 0) {
    say("VERDICT: FAIL");
    for (const failure of failures) say(`  - ${failure}`);
    return 1;
  }
  say(`VERDICT: PASS — real APFS clone with shared extents, measured by ${measurement.method}`);
  return 0;
}

/** Writes the raw evidence so CI can upload it as an artifact. */
function writeReport(path: string, lines: readonly string[]): void {
  try {
    writeFileSync(path, `${lines.join("\n")}\n`);
  } catch (error) {
    console.error(`WARNING: could not write report ${path}: ${String(error)}`);
  }
}

function scratchBase(): string {
  return process.env.RUNNER_TEMP ?? homedir() ?? tmpdir();
}

function readDf(dir: string): Df {
  const output = execFileSync("df", ["-Pk", dir], { encoding: "utf8" });
  const parsed = parseDfPk(output);
  if (parsed === undefined) throw new Error(`could not parse df -Pk output:\n${output}`);
  return parsed;
}

function growthBytes(before: Df, after: Df): number {
  return (after.usedKb - before.usedKb) * 1024;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" });
}

function tryRun(command: string, args: string[]): string | undefined {
  try {
    return run(command, args).trim();
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string") return code;
  }
  return undefined;
}

function payload(size: number): Buffer {
  const blockSize = 65536;
  const buffer = Buffer.allocUnsafe(size);
  const block = randomBytes(blockSize);
  for (let offset = 0; offset < size; offset += blockSize) {
    block.copy(buffer, offset, 0, Math.min(blockSize, size - offset));
  }
  return buffer;
}

function alignedOffset(sizeBytes: number, stride: number): number {
  const middle = Math.floor(sizeBytes / 2);
  const aligned = Math.floor(middle / stride) * stride;
  return Math.min(aligned, sizeBytes - 1);
}

function readByteAt(path: string, offset: number): number {
  const fd = openSync(path, "r");
  try {
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, offset);
    return byte.readUInt8(0);
  } finally {
    closeSync(fd);
  }
}

function writeByteAt(path: string, offset: number, value: number): void {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.from([value]), 0, 1, offset);
  } finally {
    closeSync(fd);
  }
}

function deviceOffsetAt(
  module: ExtentsModule,
  path: string,
  offset: number,
  stride: number,
): bigint {
  const fd = openSync(path, "r");
  try {
    return module.physicalMappingAt(fd, offset, stride).deviceOffset;
  } finally {
    closeSync(fd);
  }
}

const exitCode = await main().catch((error: unknown) => {
  console.error("UNEXPECTED FAILURE:", error);
  return 1;
});
process.exit(exitCode);
