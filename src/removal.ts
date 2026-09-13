import { randomBytes } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The mechanics half of `cow`'s `remove`: identity-captured, quarantine-renamed
 * deletion.
 *
 * `rm` deletes whatever occupies a path now, not the directory that was audited.
 * Between the dirty guard's probe and the delete, the path can be swapped or
 * recycled — a rename racing the removal, a create taking the freed name — and
 * an in-place `rm` would destroy the newcomer in the audited worktree's name.
 * So the directory is first stat'd (dev + inode), renamed to a sibling
 * quarantine name, and the quarantine path is re-stat'd: only when the identity
 * still matches the capture is the copy deleted. A mismatch aborts loudly and
 * moves the directory back. The original path is never deleted in place; at
 * every point before the identity is re-confirmed, a failure leaves it intact.
 *
 * The rename is also what keeps an agent holding a cwd inside the worktree from
 * blocking the removal: the path is vacated immediately even though its former
 * contents cannot be fully unlinked until that process lets go.
 *
 * The slow tail — dependency directories like `node_modules` — is deleted
 * asynchronously in-process (the server is long-lived) after the removal
 * returns, with failures logged, never thrown: a deletion the caller is no
 * longer waiting on must not turn a reported success into a late error.
 *
 * A leftover `.cow-removing-…` directory means a deletion failed midway (the
 * thrown or logged error names it): it holds the remains of a removed worktree
 * and nothing else, and is safe to delete by hand once no process is using it.
 */

/** The filesystem identity a directory is pinned by: device + inode. */
interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * The dependency-directory class removed by the background tail, recognised by
 * name at the quarantine's top level. Everything nested inside a deferred one
 * goes with it — the tail deletes with the same recursive mechanics as the
 * in-band pass.
 */
const HEAVY_DIRECTORY = "node_modules";

/** How much randomness separates a quarantine name from any other sibling. */
const QUARANTINE_RANDOM_BYTES = 12;

/**
 * Removes a directory whose identity has been captured and re-confirmed, per
 * the module doc. Resolves once the original path is vacated and the in-band
 * deletion finished; any remaining dependency directories are the background
 * tail's business.
 *
 * A missing directory is a completed removal, not an error: opencode2's
 * `remove` is idempotent the same way `rm`'s `force` was.
 */
export async function removeQuarantined(directory: string): Promise<void> {
  const captured = await captureIdentity(directory);
  if (captured === undefined) return;
  const quarantine = quarantineTarget(directory);
  try {
    await renamePath(directory, quarantine);
  } catch (cause) {
    throw new Error(
      `cow cannot remove ${directory}: moving it aside to ${quarantine} failed, ` +
        "so the original directory was left untouched.",
      { cause },
    );
  }
  await verifyQuarantined(captured, directory, quarantine);
  await deleteInBand(quarantine);
}

/**
 * The dev + inode of the directory a path names, or `undefined` when the path
 * does not exist. Any other stat failure is real corruption (a file where a
 * directory component belongs, a permission problem) and propagates: deleting
 * on an unreadable path is how the wrong thing gets destroyed.
 */
async function captureIdentity(
  directory: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    const stats = await statDirectory(directory);
    return { dev: stats.dev, ino: stats.ino };
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
}

/**
 * Re-validates the quarantine path against the capture before anything is
 * deleted. A mismatch — or a quarantine path that cannot be read at all — means
 * what sits there is not the audited directory, so it is moved back to the
 * original path and the operation aborts loudly. When even the move-back fails,
 * both failures are chained: the files are stranded at the quarantine path and
 * the error must say so.
 */
async function verifyQuarantined(
  captured: DirectoryIdentity,
  directory: string,
  quarantine: string,
): Promise<void> {
  if (await identityMatches(quarantine, captured)) return;
  try {
    await renamePath(quarantine, directory);
  } catch (cause) {
    throw new Error(
      `cow cannot remove ${directory}: the quarantine path ${quarantine} does ` +
        "not hold the directory whose identity was captured, and moving the " +
        `worktree back to ${directory} failed. Nothing was deleted; the files ` +
        `remain at ${quarantine}.`,
      { cause },
    );
  }
  throw new Error(
    `cow cannot remove ${directory}: the quarantine path ${quarantine} does ` +
      "not hold the directory whose identity was captured, so deleting it " +
      "could destroy files that were never audited. The worktree was moved " +
      `back to ${directory}; nothing was deleted.`,
  );
}

/**
 * Whether the path still holds the captured directory. An unreadable path is a
 * mismatch, never a pass: only a positive identity match allows deletion.
 */
async function identityMatches(
  path: string,
  captured: DirectoryIdentity,
): Promise<boolean> {
  try {
    const stats = await statDirectory(path);
    return stats.dev === captured.dev && stats.ino === captured.ino;
  } catch {
    return false;
  }
}

/**
 * The in-band deletion: everything in the quarantine copy except dependency
 * directories, which are handed to the background tail. With no tail work the
 * quarantine directory is removed here too, so an ordinary removal leaves no
 * trace behind. A child — or the listing, or the quarantine copy itself —
 * that cannot be deleted fails the removal with the quarantine path in the
 * message: the original path is already vacated, so the remains and their
 * meaning are the one thing the caller must learn.
 */
async function deleteInBand(quarantine: string): Promise<void> {
  const heavy: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readDirectory(quarantine);
  } catch (cause) {
    throw new Error(
      `cow could not finish removing the worktree: reading the quarantine ` +
        `copy ${quarantine} failed, so remains are left at ${quarantine}. ` +
        "The original worktree path is gone; the remains hold nothing else " +
        "and are safe to delete by hand.",
      { cause },
    );
  }
  for (const entry of entries) {
    const child = join(quarantine, entry.name);
    if (entry.name === HEAVY_DIRECTORY && entry.isDirectory()) {
      heavy.push(child);
      continue;
    }
    await removeChild(child, quarantine);
  }
  if (heavy.length > 0) {
    void deleteHeavyTail(quarantine, heavy);
    return;
  }
  try {
    await removeTree(quarantine);
  } catch (cause) {
    throw new Error(
      `cow could not finish removing the worktree: deleting the quarantine ` +
        `copy ${quarantine} failed, so remains are left at ${quarantine}. ` +
        "The original worktree path is gone; the remains hold nothing else " +
        "and are safe to delete by hand.",
      { cause },
    );
  }
}

/**
 * Deletes one in-band child, converting a failure into the removal's error.
 * Logged as well as thrown: the thrown error may reach the caller compressed,
 * while the log carries the record for whoever inspects the server.
 */
async function removeChild(child: string, quarantine: string): Promise<void> {
  try {
    await removeTree(child);
  } catch (cause) {
    const error = new Error(
      `cow could not finish removing the worktree: deleting ${child} inside ` +
        `the quarantine copy failed, so remains are left at ${quarantine}. ` +
        "The original worktree path is gone; the remains hold nothing else " +
        "and are safe to delete by hand.",
      { cause },
    );
    logFailure(error.message);
    throw error;
  }
}

/**
 * The background tail: deletes the deferred dependency directories and then the
 * quarantine shell, logging every failure and never throwing — the caller that
 * triggered this has already been told the removal succeeded.
 */
export async function deleteHeavyTail(
  quarantine: string,
  heavy: readonly string[],
): Promise<void> {
  for (const directory of heavy) {
    try {
      await removeTree(directory);
    } catch (cause) {
      logFailure(
        `cow could not delete the dependency directory ${directory} while ` +
          `finishing a removal: ${describeCause(cause)}. Its files remain ` +
          "there and are safe to delete by hand.",
      );
    }
  }
  try {
    await removeTree(quarantine);
  } catch (cause) {
    logFailure(
      `cow could not delete the quarantine directory ${quarantine} while ` +
        `finishing a removal: ${describeCause(cause)}. Whatever remains ` +
        "there is safe to delete by hand.",
    );
  }
}

/** Where a failed tail is recorded: the server's own log. */
function logFailure(message: string): void {
  console.error(message);
}

/** The human-readable half of a logged cause. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The sibling quarantine path: same parent (so the rename never crosses a
 * device), hidden dot-name with the `.cow-removing-` prefix and a random
 * suffix. The prefix keeps the name out of the worktree namespace callers
 * choose, and the randomness keeps concurrent removals from colliding with
 * each other or with a directory a caller could predict.
 */
function quarantineTarget(directory: string): string {
  const name = basename(directory);
  const random = randomBytes(QUARANTINE_RANDOM_BYTES).toString("hex");
  return join(dirname(directory), `.cow-removing-${name}-${random}`);
}

/**
 * Whether an error is a plain ENOENT — "the path is not there", which for a
 * removal means the work is already done. Node's filesystem errors carry the
 * code; anything else is not an absence answer.
 */
function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

// The filesystem seams below are module-level exports so `bun:test`'s `spyOn`
// can replace what this module calls — the same pattern as `probeUncommitted`
// and `deviceOf`. The calls are deliberately unqualified.

/** `stat`, following symlinks: a symlinked worktree still owns its contents. */
export async function statDirectory(path: string): Promise<Stats> {
  return stat(path);
}

/** `readdir`, listing the quarantine copy for the in-band deletion pass. */
export async function readDirectory(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
}

/** `rename`, the quarantine step and, on a mismatch, the way back. */
export async function renamePath(from: string, to: string): Promise<void> {
  await rename(from, to);
}

/**
 * The deletion mechanics: `rm` with a literal `force: true`, because a path
 * this function is authorized to delete may legitimately be gone already.
 */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
