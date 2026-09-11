import type { Context } from "@opencode-ai/plugin";
import { probeCowCapability } from "./capability";
import { fallbackPolicy } from "./config";
import { spawnWorkspace } from "./tool";
import type { SpawnWorkspaceDeps, SpawnWorkspaceInput } from "./tool";
import { cowStrategy } from "./strategy";

/**
 * The tool's input schema, as the v2 plugin API expects a JSON Schema. Kept a
 * plain object because the installed plugin package is a v1 build; the running
 * v2 binary decodes it.
 */
const spawnWorkspaceInput = {
  type: "object",
  properties: {
    sourceDirectory: {
      type: "string",
      description: "The project directory to clone or branch from.",
    },
    name: {
      type: "string",
      description: "Optional name for the worktree and its session.",
    },
  },
  required: ["sourceDirectory"],
  additionalProperties: false,
} as const;

/**
 * Binds `spawnWorkspace`'s seams to the live opencode2 context. The tool is
 * the layer that owns the strategy choice, so the capability probe and the
 * worktree/session APIs meet here and nowhere else.
 *
 * The fallback policy is read from the plugin's configured options and defaults
 * to `"none"`: a request for `cow` is a statement about what the caller gets,
 * so the tool never produces a Shallow worktree unless the opt-in was set.
 */
function liveDeps(ctx: Context): SpawnWorkspaceDeps {
  return {
    probe: probeCowCapability,
    createWorktree: (input) =>
      ctx.worktree.create({
        strategy: input.strategy,
        name: input.name,
        location: { directory: input.sourceDirectory },
      }),
    createSession: async (directory, name) => {
      const session = await ctx.session.create({ title: name, location: { directory } });
      return session.id;
    },
    removeWorktree: (directory) =>
      ctx.worktree.remove({ directory, force: true }),
    fallback: fallbackPolicy(ctx.options),
  };
}

/**
 * The opencode2 plugin module.
 *
 * `setup` registers the `cow` Strategy through the worktree seam, and the
 * `spawn_workspace` tool through the tool seam. Registering the Strategy also
 * selects it as the Location default; opencode2's registry still lets a caller
 * name the built-in `git` strategy explicitly, so this module does not touch
 * that behavior.
 */
export default {
  id: "opencode2-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    await ctx.worktree.transform((editor) => {
      editor.add(cowStrategy);
    });
    // `?.`: the installed plugin package is a v1 build whose Context has no
    // tool domain; the v2 binary always provides it. Optional chaining keeps
    // setup usable with a context that predates the tool seam.
    await ctx.tool?.transform((editor) => {
      editor.add({
        name: "spawn_workspace",
        description:
          "Create a worktree and start a session in it, reporting the mechanism that produced the directory.",
        input: spawnWorkspaceInput,
        execute: async (input: SpawnWorkspaceInput) => {
          const result = await spawnWorkspace(input, liveDeps(ctx));
          return {
            output: result,
            content: `Created ${result.mechanism} worktree at ${result.directory} (session ${result.sessionID}).`,
          };
        },
      });
    });
  },
};
