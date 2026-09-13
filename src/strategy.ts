import { rm } from "node:fs/promises";
import type { WorktreeDefinition } from "../types/opencode2-worktree";
import {
  assertSameDevice,
  deviceOf,
  nearestExistingDevice,
} from "./device";
import { cloneDirectory } from "./clone";
import { mayRemove } from "./dirty";
import { runPostCreateHooks } from "./hooks";
import { removeQuarantined } from "./removal";
import { probeUncommitted } from "./uncommitted";

/**
 * Builds the `cow` Strategy: materialize a Worktree as a Deep clone.
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
 *
 * `postCreate` is the validated `hooks.postCreate` list the plugin's setup
 * passes in. When non-empty, the clone is followed by those commands —
 * sequentially, in the worktree, with the source and worktree paths in the
 * environment — and the first failure removes the clone before the error
 * propagates, so a failed setup never leaves an orphan clone behind. The list
 * closes over the factory call, so the setup-ordering contract ("validate the
 * options before registering the strategy") holds by construction, with no
 * module state to install or reset.
 */
export function createCowStrategy(
  { postCreate }: { readonly postCreate: readonly string[] },
): WorktreeDefinition {
  return {
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
        // In-place `rm` — not the quarantine dance of src/removal.ts — is
        // acceptable here: the directory is a seconds-old clone this call itself
        // just created, so the provenance is known and there is no audit gap.
        await rm(input.directory, { recursive: true, force: true });
        throw new Error(`cow strategy failed to clone into ${input.directory}`, {
          cause,
        });
      }
      await runPostCreateHooks(postCreate, input.directory, input.sourceDirectory);
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
      //
      // Past the guard the deletion is never in-place: the directory's identity
      // is captured, it is renamed to a quarantine sibling, the identity is
      // re-confirmed, and only then is the copy deleted — so a swapped or
      // recycled path can never be deleted in the audited directory's name, and
      // an agent holding a cwd inside stops blocking the path. `removal.ts` owns
      // those mechanics.
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
      await removeQuarantined(input.directory);
    },

    async list() {
      return [];
    },
  };
}

/**
 * The `cow` strategy with no post-create hooks — the package's default
 * instance, exported for direct consumers of the Strategy API. The plugin
 * builds its own instance per setup through `createCowStrategy`, closing over
 * the hooks validated from the configured options.
 */
export const cowStrategy = createCowStrategy({ postCreate: [] });
