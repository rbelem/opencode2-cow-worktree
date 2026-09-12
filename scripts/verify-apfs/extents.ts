/**
 * Darwin physical-extent measurement, used only by the APFS verification job.
 *
 * `F_LOG2PHYS_EXT` asks the kernel where a byte range of a file physically
 * lives. Sampling both the source and the clone and comparing the resulting
 * device offsets is the only in-guest way to prove an APFS clone shares
 * extents: `du`/`st_blocks` double-count clones on APFS, and link counts say
 * nothing about CoW. This is the method the CI evidence is built on; the
 * `df` free-space delta in `verify-apfs.ts` is the labelled fallback.
 *
 * ## Why the call is a `python3` subprocess, not a `bun:ffi` binding
 *
 * Darwin's `fcntl` is **variadic** — `int fcntl(int, int, ...)` per XNU
 * `bsd/sys/fcntl.h` — and `bun:ffi` cannot declare a variadic prototype:
 * `FFIFunction.args` is fixed-arity. A fixed-arity binding still produced
 * correct Intel evidence because System V passes the third argument the same
 * way the variadic callee reads it, but on arm64 (AAPCS64) the anonymous
 * argument is read from a different place. The kernel then dereferenced a
 * garbage pointer and the whole Bun process faulted during exception
 * unwinding (`Segmentation fault at address 0xF9BC600000000008`, exit 139)
 * before it could write its report. No `try`/`catch` can recover from that:
 * the fault is at/through the FFI boundary.
 *
 * `log2phys.py` makes the identical `fcntl` call through Python's stdlib
 * `fcntl` module in a **child process**. The child boundary confines a bad ABI
 * or a kernel refusal: it kills the helper, not the verification run, and
 * surfaces as a non-zero child exit the caller falls back from. The stdlib
 * module is the ABI fix itself — it issues the call from C compiled against
 * the real `int fcntl(int, int, ...)` prototype, so Apple arm64's rule that
 * anonymous arguments go on the stack is satisfied by construction.
 *
 * An earlier revision used `ctypes` here, believing the child process was
 * sufficient. It was not: `ctypes` cannot express varargs, and with `argtypes`
 * unset CPython treats `fcntl` as fixed-arity (it only reaches
 * `ffi_prep_cif_var` when `argtypes` is set and shorter than the supplied
 * argument list). On Apple arm64 libffi leaves `aarch64_nfixedargs` at `0`, so
 * all three arguments go in registers while the variadic callee `va_arg`s an
 * unwritten stack slot; `copyin` failed with `EFAULT`. That downgraded the
 * failure from a Bun segfault to a clean helper exit, not to a measurement.
 *
 * The stdlib call is arch-independent, so both matrix legs (`macos-latest`
 * arm64 and `macos-15-intel`) run the strong measurement.
 *
 * Struct layout and constants (`bsd/sys/fcntl.h`, XNU `main`; verified):
 * `#pragma pack(4)` gives `struct log2phys { unsigned int l2p_flags; off_t
 * l2p_contigbytes; off_t l2p_devoffset; }` — 4 + 8 + 8 = 20 bytes,
 * little-endian on Apple silicon and Intel. `#define F_LOG2PHYS_EXT 65`.
 * `F_LOG2PHYS_EXT` is an in/out: `l2p_contigbytes` in = bytes to query (out =
 * contiguous bytes at the position), `l2p_devoffset` in = file offset (out =
 * device offset).
 *
 * NOT verified: that a modern APFS kernel accepts this fcntl for regular files
 * (`F_LOG2PHYS` was historically HFS-oriented). A refusal falls back to the
 * labelled `df`-delta method rather than crashing, and `verify-apfs.ts` prints
 * the helper's errno loudly the first time.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `F_LOG2PHYS_EXT` from XNU `bsd/sys/fcntl.h`. */
export const F_LOG2PHYS_EXT = 65;

const DEFAULT_BLOCK_BYTES = 4096;

/** The helper lives next to this module; `python3` is invoked with its path. */
const HELPER_PATH = fileURLToPath(new URL("./log2phys.py", import.meta.url));

/**
 * A 64 MiB probe at `st_blksize` granularity is ~16k lines. The cap supports
 * the 1M-sample ceiling with room to spare so `execFileSync` cannot throw
 * `ENOBUFS` on a legitimate sample set.
 */
const HELPER_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Overridable for the same reason `PYTHON` is a convention in CI: a runner
 * with a non-default interpreter name. Defaults to `python3`, which every
 * GitHub-hosted macOS image ships as `/usr/bin/python3`.
 */
function pythonBin(): string {
  return process.env.COW_LOG2PHYS_PYTHON ?? "python3";
}

/** One physical mapping as printed by `log2phys.py`. */
export interface HelperSample {
  readonly offset: bigint;
  readonly deviceOffset: bigint;
  readonly contiguousBytes: bigint;
}

/** A failure reading the physical mapping, carrying a Darwin/helper code. */
export class ExtentReadError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ExtentReadError";
    this.code = code;
  }
}

/**
 * Parses the helper's tab-separated stdout:
 * `<offset>\t<deviceOffset>\t<contiguousBytes>` per line. Exported so the
 * contract is unit-tested without a Mac.
 */
export function parseLog2Phys(stdout: string): readonly HelperSample[] {
  const samples: HelperSample[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [rawOffset, rawDevice, rawContiguous] = line.trim().split("\t");
    if (rawOffset === undefined || rawDevice === undefined) {
      throw new ExtentReadError(`log2phys helper emitted an unparseable line: ${line}`, "EPROTO");
    }
    samples.push({
      offset: toBigInt(rawOffset, line),
      deviceOffset: toBigInt(rawDevice, line),
      contiguousBytes: rawContiguous === undefined ? 0n : toBigInt(rawContiguous, line),
    });
  }
  return samples;
}

function toBigInt(value: string, line: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new ExtentReadError(`log2phys helper emitted a non-numeric field: ${line}`, "EPROTO");
  }
}

export interface HelperFailure {
  readonly status: number | undefined;
  readonly signal: string | undefined;
  readonly sourceCode: string | undefined;
  readonly stderr: string;
}

function describeHelperFailure(error: unknown): HelperFailure {
  if (typeof error !== "object" || error === null) {
    return { status: undefined, signal: undefined, sourceCode: undefined, stderr: String(error) };
  }
  const record = error as { status?: unknown; signal?: unknown; code?: unknown; stderr?: unknown };
  return {
    status: typeof record.status === "number" ? record.status : undefined,
    signal: typeof record.signal === "string" ? record.signal : undefined,
    sourceCode: typeof record.code === "string" ? record.code : undefined,
    stderr: toText(record.stderr),
  };
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

/** The first Darwin errno name the helper named (e.g. `ENOTSUP`), if any. */
function firstErrnoName(stderr: string): string | undefined {
  return stderr.match(/\b(E[A-Z][A-Z0-9_]*)\b/)?.[1];
}

function helperFailureCode(failure: HelperFailure): string {
  return (
    firstErrnoName(failure.stderr) ??
    (failure.signal !== undefined ? `ESIGNAL_${failure.signal}` : undefined) ??
    (failure.status !== undefined ? `EHELPER${failure.status}` : undefined) ??
    failure.sourceCode ??
    "EHELPER"
  );
}

function helperFailureMessage(failure: HelperFailure): string {
  const where =
    failure.signal !== undefined
      ? `log2phys helper killed by ${failure.signal}`
      : failure.status !== undefined
        ? `log2phys helper exited ${failure.status}`
        : "could not run the log2phys helper";
  return failure.stderr.length > 0 ? `${where}: ${failure.stderr}` : where;
}

/**
 * Turns whatever `child_process` threw into the code/message pair the caller
 * reports. Exported (and therefore pure) so every failure shape is testable
 * without a Mac; the precedence and message shapes are the helper's contract.
 */
export function classifyHelperFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  const failure = describeHelperFailure(error);
  return { code: helperFailureCode(failure), message: helperFailureMessage(failure) };
}

/**
 * Runs `log2phys.py` against `path` and returns its parsed samples. Any child
 * failure — a missing `python3`, a non-Darwin platform, a kernel refusal, a
 * crashed helper — becomes an `ExtentReadError`, never a fault in this
 * process.
 */
function runHelper(
  path: string,
  stride: number,
  extra: readonly string[],
): readonly HelperSample[] {
  let stdout: string;
  try {
    stdout = execFileSync(pythonBin(), [HELPER_PATH, path, "--stride", String(stride), ...extra], {
      encoding: "utf8",
      maxBuffer: HELPER_MAX_BUFFER,
    });
  } catch (error) {
    const { code, message } = classifyHelperFailure(error);
    throw new ExtentReadError(message, code);
  }
  return parseLog2Phys(stdout);
}

/** Where the file's byte range starting at `logicalOffset` physically lives. */
export function physicalMappingAt(
  path: string,
  logicalOffset: number,
  queryBytes: number,
): PhysicalMapping {
  const samples = runHelper(path, queryBytes, ["--offset", String(logicalOffset)]);
  const sample = samples[0];
  if (sample === undefined) {
    throw new ExtentReadError(
      `log2phys helper returned no mapping for offset ${logicalOffset}`,
      "EPROTO",
    );
  }
  return { deviceOffset: sample.deviceOffset, contiguousBytes: sample.contiguousBytes };
}

export interface PhysicalMapping {
  readonly deviceOffset: bigint;
  readonly contiguousBytes: bigint;
}

export interface PhysicalBlockMap {
  /** Distinct device offsets sampled across the file. */
  readonly offsets: ReadonlySet<bigint>;
  /** Bytes queried per sample. */
  readonly stride: number;
  readonly fileSize: number;
  readonly samples: number;
}

/** The allocation granularity to sample at; APFS uses 4096-byte blocks. */
export function blockStride(
  path: string,
  stat: (path: string) => { blksize: number } = statSync,
): number {
  const { blksize } = stat(path);
  return blksize > 0 ? blksize : DEFAULT_BLOCK_BYTES;
}

/**
 * Samples the physical block map of `path` at `stride`-byte intervals, in one
 * helper invocation. One device offset is recorded per sampled logical offset;
 * the Jaccard comparison in `logic.ts` then reports how much of the map is
 * shared.
 */
export function samplePhysicalBlocks(path: string, maxSamples = 1_000_000): PhysicalBlockMap {
  const stride = blockStride(path);
  const fileSize = statSync(path).size;
  const samples = runHelper(path, stride, ["--max-samples", String(maxSamples)]);
  const offsets = new Set<bigint>();
  for (const sample of samples) offsets.add(sample.deviceOffset);
  return { offsets, stride, fileSize, samples: samples.length };
}
