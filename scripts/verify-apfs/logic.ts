/**
 * Pure decision logic for the macOS APFS clone verification job.
 *
 * The distinction this module encodes is the whole point of the job:
 *
 * - **Weak:** the clone code path "ran without error" (a clean exit).
 * - **Required:** a real APFS clone with genuinely shared physical extents,
 *   confirmed by measuring the source's and clone's physical block maps.
 *
 * Everything here is platform-independent and unit-tested on Linux. The Darwin
 * syscalls live in `extents.ts`; the orchestration lives in `verify-apfs.ts`.
 */

/** The measured method that produced the shared-extent evidence. */
export type ExtentMethod = "F_LOG2PHYS_EXT" | "df-delta";

/**
 * Minimum Jaccard overlap of the source's and clone's physical block sets that
 * counts as "shared extents". A genuine `copyfile(3)` clone maps every block to
 * the same device offset (≈1.0); a byte copy shares almost none (≈0.0). A
 * hardlink also scores ≈1.0, which is why the mutation check below is required
 * and not optional.
 */
export const MIN_OVERLAP = 0.98;

/**
 * A clone may grow the volume by a little metadata, but it cannot grow it by
 * anything close to the file size. A real byte copy grows it by the file size;
 * a real clone by (approximately) nothing.
 */
export const MAX_CLONE_GROWTH_RATIO = 0.1;

/** The minimum free-space growth one mutated block must cause under `df-delta`. */
export const MIN_MUTATION_GROWTH_BYTES = 4096;

/** Default size of the probe file. Large enough that df noise cannot hide a copy. */
export const DEFAULT_SIZE_MIB = 64;

export interface Evaluation {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface VerifyOptions {
  /** Turn a clean local skip into a hard failure. Set by the CI job. */
  readonly requireApfs: boolean;
  /** Where to write the raw evidence artifact. */
  readonly reportPath: string;
  /** Probe file size in MiB. */
  readonly sizeMib: number;
  /** Scratch directory; defaults to a fresh temp dir on the target volume. */
  readonly dir: string | undefined;
}

/**
 * Parses the small option surface. `--require` makes a skip fail; the report
 * path is always written so a failing run still uploads evidence.
 */
export function parseOptions(argv: readonly string[]): VerifyOptions {
  let requireApfs = false;
  let reportPath = "apfs-verification.txt";
  let sizeMib = DEFAULT_SIZE_MIB;
  let dir: string | undefined;

  for (const arg of argv) {
    if (arg === "--require") requireApfs = true;
    else if (arg.startsWith("--report=")) reportPath = valueOf(arg, "--report=");
    else if (arg.startsWith("--size-mib=")) sizeMib = parseSize(valueOf(arg, "--size-mib="), sizeMib);
    else if (arg.startsWith("--dir=")) dir = valueOf(arg, "--dir=");
  }

  return { requireApfs, reportPath, sizeMib, dir };
}

function valueOf(arg: string, prefix: string): string {
  return arg.slice(prefix.length);
}

function parseSize(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The labels `diskutil info` uses for a volume's file system personality. The
 * canonical one is `File System Personality:`; the bundle and user-visible
 * names are accepted as fallbacks so a label change in a future macOS cannot
 * turn a real APFS volume into a hard failure.
 */
const PERSONALITY_PATTERNS: readonly RegExp[] = [
  /File System Personality:\s*(.+)/i,
  /Type \(Bundle\):\s*(.+)/i,
  /Name \(User Visible\):\s*(.+)/i,
];

/**
 * Reads the volume's file system personality from `diskutil info` output, e.g.
 * the `File System Personality:   APFS` line, or `undefined` when none of the
 * known labels is present.
 *
 * `diskutil info` must be given a volume — a device node or a **mount point** —
 * not an arbitrary subdirectory. `diskutil info <subdir>` fails with
 * `Could not find disk`, which is the bug this job hit on its first real run:
 * resolve the mount point with `df` first (see `parseDfVolume`).
 */
export function parseFilesystemPersonality(diskutilStdout: string): string | undefined {
  for (const pattern of PERSONALITY_PATTERNS) {
    const match = diskutilStdout.match(pattern);
    const value = match?.[1]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

/** The device node and mount point backing a path, as `df -Pk` reports them. */
export interface DfVolume {
  readonly device: string | undefined;
  readonly mountPoint: string | undefined;
}

/**
 * Parses the device node and mount point from the data line of
 * `df -Pk <path>`: `Filesystem 1024-blocks Used Available Capacity Mounted on`.
 *
 * The mount point is everything after the `Capacity` field (the one ending in
 * `%`), joined back up, so a mount point containing spaces survives. The mount
 * point matters because it is what `diskutil info` accepts; a subdirectory is
 * not a disk.
 */
export function parseDfVolume(dfStdout: string): DfVolume | undefined {
  const dataLine = dfStdout.trim().split("\n").at(-1);
  if (dataLine === undefined) return undefined;
  const fields = dataLine.trim().split(/\s+/);
  const device = fields[0];
  // A real data line starts with a filesystem (a `/dev/...` node, an NFS
  // `host:/path`, or `map`/`devfs`); reject header text and junk so a failed
  // `df` never resolves the volume to the word "Filesystem".
  if (device === undefined || !device.includes("/")) return undefined;
  const capacityIndex = fields.findIndex((field) => /^\d+%$/.test(field));
  const mountPoint =
    capacityIndex >= 0 ? fields.slice(capacityIndex + 1).join(" ") : fields.at(-1);
  return {
    device,
    mountPoint: mountPoint !== undefined && mountPoint.length > 0 ? mountPoint : undefined,
  };
}

/**
 * Reads a volume's file system type from `mount(8)` output, e.g.
 * `/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)`.
 *
 * Used only as a labelled fallback when `diskutil` reports no personality. The
 * target device/mount point comes from `df`, not from prefix-matching the
 * literal path: on modern macOS `/Users` is a firmlink into
 * `/System/Volumes/Data`, so a path-prefix match would wrongly pick the
 * read-only System volume mounted at `/`.
 */
export function parseMountFsType(mountStdout: string, target: DfVolume): string | undefined {
  for (const line of mountStdout.split("\n")) {
    const match = line.match(/^(.+) on (.+) \(([^,)]+)/);
    if (match === null) continue;
    const source = match[1]?.trim();
    const mountPoint = match[2]?.trim();
    const fsType = match[3]?.trim();
    const sourceMatches = target.device !== undefined && source === target.device;
    const mountMatches = target.mountPoint !== undefined && mountPoint === target.mountPoint;
    if ((sourceMatches || mountMatches) && fsType !== undefined && fsType.length > 0) {
      return fsType;
    }
  }
  return undefined;
}

/**
 * Parses the data line of `df -Pk <path>`. On macOS this is `Filesystem
 * 1024-blocks Used Available Capacity Mounted on`; on GNU/Linux `-P` forces
 * the POSIX layout `Filesystem 1024-blocks Used Available Capacity Mounted on`
 * as well (the `-k` makes the block column 1024-blocks). The first data field
 * is the device, so `Used` is index 2 and `Available` index 3 on both. Returns
 * used and available in KiB.
 */
export function parseDfPk(dfStdout: string): { usedKb: number; availableKb: number } | undefined {
  const dataLine = dfStdout.trim().split("\n").at(-1);
  if (dataLine === undefined) return undefined;
  const fields = dataLine.trim().split(/\s+/);
  const usedKb = toFiniteNumber(fields[2]);
  const availableKb = toFiniteNumber(fields[3]);
  if (usedKb === undefined || availableKb === undefined) return undefined;
  return { usedKb, availableKb };
}

function toFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Jaccard overlap (intersection / union) of two physical block sets. */
export function jaccardOverlap(
  source: ReadonlySet<bigint>,
  clone: ReadonlySet<bigint>,
): number {
  let intersection = 0;
  const [small, large] = source.size <= clone.size ? [source, clone] : [clone, source];
  for (const value of small) {
    if (large.has(value)) intersection += 1;
  }
  const union = source.size + clone.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ExtentSharingInput {
  readonly method: ExtentMethod;
  /** Jaccard overlap of physical block sets; absent under the df fallback. */
  readonly overlap: number | undefined;
  /** Free-space growth (bytes) across the clone. */
  readonly cloneGrowthBytes: number;
  readonly fileSizeBytes: number;
}

/**
 * Evaluates whether the clone genuinely shared extents. This is the "required"
 * bar: a measurement, not a clean exit.
 */
export function evaluateExtentSharing(input: ExtentSharingInput): Evaluation {
  if (input.method === "F_LOG2PHYS_EXT") return evaluateBlockOverlap(input);
  return evaluateGrowth(input);
}

function evaluateBlockOverlap(input: ExtentSharingInput): Evaluation {
  const failures: string[] = [];
  if (input.overlap === undefined) {
    failures.push("F_LOG2PHYS_EXT was selected but no overlap was measured");
  } else if (input.overlap < MIN_OVERLAP) {
    failures.push(
      `physical-block overlap ${input.overlap.toFixed(6)} < ${MIN_OVERLAP} ` +
        `(source and clone do not share extents)`,
    );
  }
  return { ok: failures.length === 0, failures };
}

function evaluateGrowth(input: ExtentSharingInput): Evaluation {
  const failures: string[] = [];
  const limit = input.fileSizeBytes * MAX_CLONE_GROWTH_RATIO;
  if (input.cloneGrowthBytes >= limit) {
    failures.push(
      `clone grew the volume by ${input.cloneGrowthBytes} B, not < ${limit} B ` +
        `(the file was copied, not cloned)`,
    );
  }
  return { ok: failures.length === 0, failures };
}

export interface CowMutationInput {
  readonly method: ExtentMethod;
  /** The mutated block's device offset changed after the write. */
  readonly mutatedBlockMoved: boolean;
  /** The source byte changed too — the clone is a hardlink, not CoW. */
  readonly sourceByteChanged: boolean;
  /** Free-space growth (bytes) caused by the mutation. */
  readonly mutationGrowthBytes: number;
}

/**
 * Evaluates that mutating one byte in the clone behaved copy-on-write: the
 * source is untouched and the clone's block moved (or, under the df fallback,
 * the volume grew). A hardlink fails on `sourceByteChanged`.
 */
export function evaluateCowMutation(input: CowMutationInput): Evaluation {
  const failures: string[] = [];
  if (input.sourceByteChanged) {
    failures.push("mutating the clone changed the source: the clone is a hardlink, not a CoW clone");
  }
  if (input.method === "F_LOG2PHYS_EXT") {
    if (!input.mutatedBlockMoved) {
      failures.push(
        "the mutated block's physical offset did not change: the write was not copy-on-write",
      );
    }
  } else if (input.mutationGrowthBytes < MIN_MUTATION_GROWTH_BYTES) {
    failures.push(
      `mutating a block grew the volume by ${input.mutationGrowthBytes} B, ` +
        `< ${MIN_MUTATION_GROWTH_BYTES} B`,
    );
  }
  return { ok: failures.length === 0, failures };
}
