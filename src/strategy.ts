import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeDefinition } from "../types/opencode2-worktree";
import { cloneDirectory } from "./clone";
import { mayRemove } from "./dirty";
import {
  assertSameDevice,
  deviceOf,
  nearestExistingDevice,
} from "./tool";

/**
 * The `cow` Strategy: materialize a Worktree as a Deep clone.
 *
 * `create` reflinks the source working directory — ignored files included —
 * into the directory opencode2 has already chosen. It fails loudly rather than
 * falling back: the CoW capability predicate belongs to the caller-facing tool,
 * so a request for `cow` either clones or throws. `list` returns nothing on
 * purpose — opencode2 reads its own records for inventory, so a Strategy is not
 * the source of truth for what exists.
 *
 * opencode2 may hand the strategy a target on a different filesystem (its
 * default worktree parent is under the data directory). A reflink cannot cross
 * a device boundary, so the strategy pre-flights the same device rule the tool
 * applies and throws an actionable error before any directory is created; it
 * does not relocate the target, because a caller-supplied path is not the
 * strategy's to silently override.
 */
export const cowStrategy: WorktreeDefinition = {
  id: "cow",

  async create(input, { signal }) {
    signal.throwIfAborted();
    // Thrown outside the try so the actionable message is not rewrapped as a
    // generic clone failure. `input.directory` is the final target opencode2
    // has assembled; it may not exist yet, so the device of its nearest
    // existing ancestor decides whether a reflink can land there.
    const [sourceDevice, targetDevice] = await Promise.all([
      deviceOf(input.sourceDirectory),
      nearestExistingDevice(input.directory, deviceOf),
    ]);
    assertSameDevice(input.sourceDirectory, sourceDevice, input.directory, targetDevice);
    try {
      await cloneDirectory(input.sourceDirectory, input.directory);
    } catch (cause) {
      // Leave nothing behind: cloneDirectory creates the target before it can
      // fail, so a partial tree would otherwise survive a failed create.
      await rm(input.directory, { recursive: true, force: true });
      throw new Error(`cow strategy failed to clone into ${input.directory}`, {
        cause,
      });
    }
    return { directory: input.directory };
  },

  async remove(input) {
    // opencode2's `force` is its two-phase confirm protocol — "proceed despite
    // uncommitted changes" — not `rm`'s "ignore a missing path" flag. The
    // built-in git strategy maps it to `git worktree remove --force` and
    // refuses while the worktree is dirty; the TUI turns the refusal into a
    // confirmation and retries with `force: true`. So the probe is skipped
    // entirely once the user has confirmed, and `rm` always receives a literal
    // `force: true` (a directory this call is authorized to delete may
    // legitimately be gone already).
    //
    // At `force: false` a dirty — or unknowable — directory refuses before any
    // filesystem change, so uncommitted work is never silently destroyed
    // (issue #13). `input.force` is authorization for the decision, not a flag
    // for `rm`.
    const uncommitted = input.force
      ? undefined
      : await probeUncommitted(input.directory);
    const decision = mayRemove({ force: input.force, uncommitted });
    if (!decision.remove) {
      throw new Error(
        `cow refuses to remove ${input.directory} without force: ${decision.reason}. ` +
          "Re-run with force to delete them.",
      );
    }
    await rm(input.directory, { recursive: true, force: true });
  },

  async list() {
    return [];
  },
};

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
): Promise<readonly string[] | undefined> {
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
function porcelainPaths(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter((path) => path.length > 0);
}
