import type { Context } from "@opencode-ai/plugin";
import { stat } from "node:fs/promises";
import { probeCowCapability } from "./capability";
import { fallbackPolicy, postCreateHooks, targetRoot } from "./config";
import { deviceOf, isDirectory } from "./device";
import { listCowWorktrees, spawnWorkspace } from "./tool";
import type {
  FallbackPolicy,
  SpawnWorkspaceDeps,
  SpawnWorkspaceInput,
} from "./tool";
import { createCowStrategy } from "./strategy";

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
 * The tool's declared output, as a JSON Schema. A tool that returns an `output`
 * field must declare its schema: opencode2 treats an undeclared output as a
 * defect ("Tool result declared output without an output schema"), not as a
 * recoverable error. The reported mechanism is part of the contract, so the
 * structured result is declared rather than flattened into text.
 */
const spawnWorkspaceOutput = {
  type: "object",
  properties: {
    sessionID: {
      type: "string",
      description: "The session started in the created directory.",
    },
    directory: {
      type: "string",
      description: "The working directory that was produced.",
    },
    mechanism: {
      type: "string",
      enum: ["cow", "git"],
      description: "The mechanism that produced the directory.",
    },
    attached: {
      type: "boolean",
      description:
        "True when the session was attached to an existing worktree instead of a new clone.",
    },
  },
  required: ["sessionID", "directory", "mechanism"],
  additionalProperties: false,
} as const;

/**
 * `list_worktrees` takes no input. The empty object keeps the shape the tool
 * seam expects (a JSON Schema object) while declaring that no properties
 * exist.
 */
const listWorktreesInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/**
 * `list_worktrees`' declared output, with the same rule as
 * `spawn_workspace`'s: a tool that returns an `output` field must declare its
 * schema. The four entry fields are exactly what `listCowWorktrees` derives.
 */
const listWorktreesOutput = {
  type: "object",
  properties: {
    worktrees: {
      type: "array",
      description: "The location's cow worktrees, in inventory order.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The worktree directory's basename.",
          },
          directory: {
            type: "string",
            description: "The worktree directory, as the worktree inventory records it.",
          },
          strategy: {
            type: "string",
            enum: ["cow"],
            description: "Only cow worktrees are listed.",
          },
          createdAt: {
            type: "string",
            description:
              "ISO 8601 timestamp of the directory's birthtime, falling back to its " +
              "mtime when the filesystem reports no birthtime.",
          },
        },
        required: ["name", "directory", "strategy", "createdAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["worktrees"],
  additionalProperties: false,
} as const;

/**
 * Binds `spawnWorkspace`'s seams to the live opencode2 context. The tool is
 * the layer that owns the strategy choice, so the capability probe and the
 * worktree/session APIs meet here and nowhere else.
 *
 * The fallback policy and the Worktree target root arrive already validated —
 * `setup` read them from the plugin's options once and passes the values in.
 * The fallback defaults to `"none"`: a request for `cow` is a statement about
 * what the caller gets, so the tool never produces a Shallow worktree unless
 * the opt-in was set. The target root defaults to unset, which makes the tool
 * place the Worktree beside the source — the same-filesystem parent a CoW
 * clone requires.
 */
function liveDeps(
  ctx: Context,
  fallback: FallbackPolicy,
  worktreeRoot: string | undefined,
): SpawnWorkspaceDeps {
  return {
    probe: probeCowCapability,
    probeDevice: deviceOf,
    listWorktrees: () => ctx.worktree.list(),
    isDirectory,
    createWorktree: (input) =>
      ctx.worktree.create({
        strategy: input.strategy,
        name: input.name,
        location: { directory: input.sourceDirectory },
        directory: input.parentDirectory,
      }),
    createSession: async (directory, name) => {
      const session = await ctx.session.create({ title: name, location: { directory } });
      return session.id;
    },
    removeWorktree: (directory) =>
      ctx.worktree.remove({ directory, force: true }),
    fallback,
    targetRoot: worktreeRoot,
  };
}

/**
 * The opencode2 plugin module.
 *
 * `setup` registers the `cow` Strategy through the worktree seam, and the
 * `spawn_workspace` and `list_worktrees` tools through the tool seam.
 * Registering the Strategy also selects it as the Location default; opencode2's
 * registry still lets a caller name the built-in `git` strategy explicitly, so
 * this module does not touch that behavior.
 */
export default {
  id: "opencode2-cow-worktree",
  async setup(ctx: Context): Promise<void> {
    // Every plugin option is validated exactly once, here, before anything is
    // registered: a misconfiguration must fail the plugin load, not surface
    // inside the first tool call or halfway through a create. The validated
    // values close over into the strategy and the tool bindings below, so
    // the tool path never re-reads — or re-throws on — `ctx.options`.
    const hooks = postCreateHooks(ctx.options);
    const fallback = fallbackPolicy(ctx.options);
    const worktreeRoot = targetRoot(ctx.options);
    await ctx.worktree.transform((editor) => {
      editor.add(createCowStrategy({ postCreate: hooks }));
    });
    // `?.`: the installed plugin package is a v1 build whose Context has no
    // tool domain; the v2 binary always provides it. Optional chaining keeps
    // setup usable with a context that predates the tool seam.
    await ctx.tool?.transform((editor) => {
      editor.add({
        name: "spawn_workspace",
        description:
          "Create a worktree and start a session in it, reporting the mechanism that produced the directory. " +
          "When a worktree with the requested name already exists and was produced by the cow strategy, the " +
          "session is attached to it instead of creating a new directory; anything else at that name is refused.",
        input: spawnWorkspaceInput,
        output: spawnWorkspaceOutput,
        // A tool defaults into CodeMode, which advertises it to the model only
        // through `execute`. This tool must be callable by name, so it is kept
        // on the provider's native tool list.
        options: { codemode: false },
        execute: async (input: SpawnWorkspaceInput) => {
          const result = await spawnWorkspace(input, liveDeps(ctx, fallback, worktreeRoot));
          // The text is what tells attach from create: on attach `mechanism`
          // reports the found directory's mechanism, and the caller must never
          // read that as a fresh clone having happened.
          const content = result.attached
            ? `Attached to existing cow worktree at ${result.directory} (session ${result.sessionID}); no new worktree was created.`
            : `Created ${result.mechanism} worktree at ${result.directory} (session ${result.sessionID}).`;
          return {
            output: result,
            content,
          };
        },
      });
      editor.add({
        name: "list_worktrees",
        description:
          "List this location's cow worktrees: each entry carries the directory's basename as " +
          "name, the directory, the strategy, and createdAt from a stat of the directory " +
          "(birthtime, falling back to mtime when the filesystem reports none). Derived from " +
          "opencode2's worktree inventory alone — there is no sessions field, because server " +
          "plugins cannot enumerate sessions (ADR 0003). The list fails rather than skipping " +
          "when an inventory row's directory cannot be read: the inventory is truth.",
        input: listWorktreesInput,
        output: listWorktreesOutput,
        // Same reason as spawn_workspace above: callable by name, not routed
        // through CodeMode.
        options: { codemode: false },
        execute: async () => {
          const worktrees = await listCowWorktrees({
            // Own minimal deps, not liveDeps: this read-only call touches only
            // the inventory and one stat per row, none of spawn_workspace's
            // other seams. (Option validation happens once in setup, so there
            // is no validation side effect to dodge either way.)
            listWorktrees: () => ctx.worktree.list(),
            statEntry: stat,
          });
          const summary =
            worktrees.length === 0 ? "0 cow worktree(s)" : `${worktrees.length} cow worktree(s):`;
          return {
            output: { worktrees },
            content: `${summary}\n${JSON.stringify(worktrees, null, 2)}`,
          };
        },
      });
    });
  },
};
