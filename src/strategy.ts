import { rm } from "node:fs/promises";
import type { WorktreeDefinition } from "../types/opencode2-worktree";
import { cloneDirectory } from "./clone";
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
    // `input.force` is opencode2's two-phase confirm protocol, not `rm`'s
    // "ignore a missing path" flag. The built-in git strategy maps it to
    // `git worktree remove --force` and raises `forceRequired` when git refuses
    // because of uncommitted work; the TUI turns that into a confirmation and
    // retries with `force: true`. Passing it through keeps that seam available.
    //
    // Consequence worth knowing: `node:fs` `rm` has no equivalent refusal, so
    // this strategy currently deletes a dirty worktree at `force: false` where
    // git would have stopped. That is a bug in its own right (issue #13), and
    // the fix belongs here rather than in an unconditional `force: true`, which
    // would delete the protocol instead of implementing it.
    await rm(input.directory, { recursive: true, force: input.force });
  },

  async list() {
    return [];
  },
};
