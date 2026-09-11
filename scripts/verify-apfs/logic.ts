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
 * `diskutil info <path>` reports the volume's personality on a line like
 * `   File System Personality:   APFS`. Returns the trimmed value, or
 * `undefined` when the line is absent.
 */
export function parseFilesystemPersonality(diskutilStdout: string): string | undefined {
  const match = diskutilStdout.match(/File System Personality:\s*(.+)/i);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Parses the data line of `df -Pk <path>`: `Filesystem 1024-blocks Used
 * Available Capacity Mounted-on`. Returns used and available in KiB.
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
