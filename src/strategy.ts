import { rm } from "node:fs/promises";
import type { WorktreeDefinition } from "../types/opencode2-worktree";
import { cloneDirectory } from "./clone";

/**
 * The `cow` Strategy: materialize a Worktree as a Deep clone.
 *
 * `create` reflinks the source working directory — ignored files included —
 * into the directory opencode2 has already chosen. It fails loudly rather than
 * falling back: the CoW capability predicate belongs to the caller-facing tool,
 * so a request for `cow` either clones or throws. `list` returns nothing on
 * purpose — opencode2 reads its own records for inventory, so a Strategy is not
 * the source of truth for what exists.
 */
export const cowStrategy: WorktreeDefinition = {
  id: "cow",

  async create(input, { signal }) {
    signal.throwIfAborted();
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
    await rm(input.directory, { recursive: true, force: input.force });
  },

  async list() {
    return [];
  },
};
