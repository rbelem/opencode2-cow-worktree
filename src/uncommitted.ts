/**
 * The impure half of `cow`'s remove guard: the `git status --porcelain` probe
 * that reports a worktree's uncommitted changes, or the deliberate "unknown".
 *
 * Split out of `strategy.ts` (ticket 10) so it sits beside the pure decision
 * it feeds — `dirty.ts`'s `mayRemove`, which stays free of I/O. This module
 * owns the subprocess: `execFile` runs `git` directly, no shell, and every
 * failure mode (no metadata, non-zero exit, timeout, no git on the machine)
 * is reported as `undefined`, which the decision treats as dirty. A probe
 * that fails is never "clean".
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UncommittedChanges } from "./dirty";

/** How long `git status` may take before the probe gives up and reports unknown. */
const GIT_TIMEOUT_MS = 5_000;

const run = promisify(execFile);

/**
 * Reports the paths a worktree has uncommitted changes in, or `undefined` when
 * that cannot be determined. A probe that fails is never "clean".
 *
 * The metadata gate keeps the probe off a non-repository directory: without
 * `.git` (a file, as in a linked worktree, or a directory, as in a clone) no
 * porcelain status exists, so the answer is unknown and `remove` refuses. A
 * directory that is gone answers `undefined` too — `stat` following a symlink
 * is intentional, because a symlinked worktree still owns git metadata.
 *
 * Injected through a module-level `spyOn` seam in the tests, like `deviceOf`:
 * `bun:test` can replace an export the module itself calls. The call is
 * deliberately unqualified and outside destructuring so that replacement
 * takes effect.
 *
 * `execFile` runs `git` directly — no shell, no inherited prompt — and CI=1
 * suppresses any credential or editor interaction; the 5s timeout bounds a
 * git that hangs on a lock. A pager needs a tty and is never started by
 * `status --porcelain` here. Any error, non-zero exit, or timeout is unknown.
 */
export async function probeUncommitted(
  directory: string,
): Promise<UncommittedChanges> {
  if (!(await hasGitMetadata(directory))) return undefined;
  try {
    const { stdout } = await run(
      "git",
      ["-C", directory, "status", "--porcelain"],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_PAGER: "cat", GIT_EDITOR: "true", CI: "1" },
      },
    );
    return porcelainPaths(stdout);
  } catch {
    return undefined;
  }
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The changed paths in `git status --porcelain` output. The status and the
 * path are separated by the first space; a rename's `old -> new` is kept
 * whole, because both ends name something the user would lose.
 */
function porcelainPaths(stdout: string): UncommittedChanges {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter((path) => path.length > 0);
}
