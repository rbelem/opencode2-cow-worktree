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
 * The syscall is reached through `bun:ffi`, the same mechanism as the backend
 * under test (`src/platform-darwin-ffi.ts`), so this runs on the runner with no
 * native build step.
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
 * (`F_LOG2PHYS` was historically HFS-oriented), and that `bun:ffi`'s
 * `fcntl(fd, cmd, ptr)` binding matches libSystem's ABI. The first real CI run
 * failed before this code was reached, so neither has been observed. A refusal
 * falls back to the labelled `df`-delta method rather than crashing, and
 * `physicalMappingAt` prints the reason loudly the first time it is refused.
 */
import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, openSync, statSync } from "node:fs";

/** `F_LOG2PHYS_EXT` from XNU `bsd/sys/fcntl.h`. */
export const F_LOG2PHYS_EXT = 65;

/** `#pragma pack(4)` makes `struct log2phys` 20 bytes, not 24. */
export const L2P_STRUCT_BYTES = 20;

const DEFAULT_BLOCK_BYTES = 4096;

const ERRNO_NAMES: Readonly<Record<number, string>> = {
  1: "EPERM",
  5: "EIO",
  13: "EACCES",
  14: "EFAULT",
  18: "EXDEV",
  22: "EINVAL",
  25: "ENOTTY",
  34: "ERANGE",
  45: "ENOTSUP",
  78: "ENOSYS",
};

interface Fcns {
  readonly fcntl: (fd: number, cmd: number, arg: Buffer) => number;
  readonly __error: () => number;
}

let symbols: Fcns | undefined;

function load(): Fcns {
  if (symbols !== undefined) return symbols;
  const loaded = dlopen("/usr/lib/libSystem.B.dylib", {
    fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" },
    __error: { args: [], returns: FFIType.ptr },
  }) as { symbols: Fcns };
  symbols = loaded.symbols;
  return symbols;
}

function darwinErrno(fcns: Fcns): string {
  const errno = read.i32(fcns.__error());
  return ERRNO_NAMES[errno] ?? `ERRNO_${errno}`;
}

/** A failure reading the physical mapping, carrying the Darwin errno name. */
export class ExtentReadError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ExtentReadError";
    this.code = code;
  }
}

let warnedOnce = false;

/**
 * Prints the raw kernel refusal the first time. The fallback to `df` is
 * labelled in the report either way, but if `F_LOG2PHYS_EXT` is rejected on
 * APFS the reason must be visible, not inferred from a sudden switch of
 * measured method.
 */
function warnOnce(code: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.error(`[extents] F_LOG2PHYS_EXT refused by the kernel: ${code}`);
}

export interface PhysicalMapping {
  readonly deviceOffset: bigint;
  readonly contiguousBytes: bigint;
}

/**
 * Where the file's byte range starting at `logicalOffset` physically lives.
 * Throws `ExtentReadError` on a kernel refusal.
 */
export function physicalMappingAt(
  fd: number,
  logicalOffset: number,
  queryBytes: number,
): PhysicalMapping {
  const fcns = load();
  const struct = Buffer.alloc(L2P_STRUCT_BYTES);
  struct.writeUInt32LE(0, 0);
  struct.writeBigInt64LE(BigInt(queryBytes), 4);
  struct.writeBigInt64LE(BigInt(logicalOffset), 12);

  const result = fcns.fcntl(fd, F_LOG2PHYS_EXT, struct);
  if (result === -1) {
    const code = darwinErrno(fcns);
    warnOnce(code);
    throw new ExtentReadError(
      `F_LOG2PHYS_EXT failed at offset ${logicalOffset} (${queryBytes} B queried)`,
      code,
    );
  }

  return {
    contiguousBytes: struct.readBigInt64LE(4),
    deviceOffset: struct.readBigInt64LE(12),
  };
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
export function blockStride(path: string): number {
  const { blksize } = statSync(path);
  return blksize > 0 ? blksize : DEFAULT_BLOCK_BYTES;
}

/**
 * Samples the physical block map of `path` at `stride`-byte intervals. One
 * device offset is recorded per sampled logical offset; the Jaccard comparison
 * in `logic.ts` then reports how much of the map is shared.
 */
export function samplePhysicalBlocks(path: string, maxSamples = 1_000_000): PhysicalBlockMap {
  const stride = blockStride(path);
  const fileSize = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const offsets = new Set<bigint>();
    let samples = 0;
    for (let offset = 0; offset < fileSize && samples < maxSamples; offset += stride) {
      offsets.add(physicalMappingAt(fd, offset, stride).deviceOffset);
      samples += 1;
    }
    return { offsets, stride, fileSize, samples };
  } finally {
    closeSync(fd);
  }
}
