import type { Context } from "@opencode-ai/plugin";
import { cowStrategy } from "./strategy";

/**
 * The opencode2 plugin module.
 *
 * `setup` registers the `cow` Strategy through the worktree seam. Registration
 * also selects it as the Location default; opencode2's registry still lets a
 * caller name the built-in `git` strategy explicitly, so this module does not
 * touch that behavior.
 */
export default {
  id: "opencode2-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    await ctx.worktree.transform((editor) => {
      editor.add(cowStrategy);
    });
  },
};
