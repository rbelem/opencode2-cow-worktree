import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/plugin";
import { findCowRoot, findNonCowRoot } from "./fs-roots";

// Discover the roots instead of hardcoding this machine's mounts. The source
// directory need not be a git repository: the fallback path only decides
// *which strategy to request*, and git worktree creation is opencode2's job,
// covered end-to-end in the integration harness.
const nonCowRoot = await findNonCowRoot();
const cowRoot = await findCowRoot();

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(root: string): Promise<string> {
  const dir = await mkdtemp(join(root, "cow-fallback-"));
  scratchDirs.push(dir);
  return dir;
}

interface Recorded {
  readonly strategies: string[];
  readonly removed: string[];
  /** The `Worktree.CreateInput.directory` parent each create was given. */
  readonly parents: Array<string | undefined>;
}

interface RegisteredTool {
  readonly name: string;
  readonly execute: (input: { sourceDirectory: string; name?: string }) => Promise<{
    output: { mechanism: string; directory: string; sessionID: string };
  }>;
}

interface Harness {
  readonly tool: RegisteredTool;
  readonly recorded: Recorded;
  /** The real directories each fake create returned. */
  readonly createdDirs: string[];
}

/**
 * Builds a fake Context that records everything setup and the tools touch.
 * Split from `harness` so the misconfiguration pins can run `plugin.setup`
 * themselves and assert the plugin load — and exactly what was registered.
 */
function recordCtx(
  options: Record<string, unknown> | undefined,
  harnessOptions: { readonly sessionCreateError?: Error } = {},
): {
  readonly ctx: Parameters<typeof plugin.setup>[0];
  readonly recorded: Recorded;
  readonly registeredToolNames: string[];
  readonly addedStrategies: string[];
  readonly createdDirs: string[];
  readonly spawnWorkspaceTool: () => RegisteredTool;
} {
  const recorded: Recorded = { strategies: [], removed: [], parents: [] };
  const registeredToolNames: string[] = [];
  const addedStrategies: string[] = [];
  let registered: RegisteredTool | undefined;
  // The cow create writes its occupancy marker into the returned directory, so
  // each create hands back a real scratch dir instead of an invented path.
  const createdDirs: string[] = [];

  const ctx = {
    options,
    worktree: {
      create: async (input: { strategy?: string; directory?: string }) => {
        recorded.strategies.push(input.strategy ?? "default");
        recorded.parents.push(input.directory);
        const dir = await mkdtemp(join(tmpdir(), "cow-fallback-wt-"));
        createdDirs.push(dir);
        return { directory: dir };
      },
      remove: async (input: { directory: string }) => {
        recorded.removed.push(input.directory);
      },
      transform: async (callback: (editor: { add: () => void }) => void) => {
        callback({
          add: () => {
            addedStrategies.push("cow");
          },
        });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({
          add: (tool: any) => {
            // setup registers list_worktrees too; the harness drives
            // spawn_workspace, so capture by name rather than by order.
            registeredToolNames.push(tool.name);
            if (tool.name === "spawn_workspace") registered = tool as RegisteredTool;
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      create: async () => {
        if (harnessOptions.sessionCreateError !== undefined) {
          throw harnessOptions.sessionCreateError;
        }
        return { id: "ses_live" };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  return {
    ctx,
    recorded,
    registeredToolNames,
    addedStrategies,
    createdDirs,
    spawnWorkspaceTool: () => {
      if (registered === undefined) throw new Error("spawn_workspace was not registered");
      return registered;
    },
  };
}

async function harness(
  options: Record<string, unknown> | undefined,
  harnessOptions: { readonly sessionCreateError?: Error } = {},
): Promise<Harness> {
  const { ctx, recorded, spawnWorkspaceTool, createdDirs } = recordCtx(options, harnessOptions);
  // Marker writes land in real scratch directories; clean them up with the rest.
  scratchDirs.push(...createdDirs);
  await plugin.setup(ctx);
  return { tool: spawnWorkspaceTool(), recorded, createdDirs };
}

// Validation pins (ticket 11): every plugin option is checked once at setup,
// so a misconfiguration fails the plugin load — before any tool exists to
// call — instead of surfacing on the first tool invocation. No filesystem is
// involved: validation runs before anything is registered.

test("a misconfigured fallback fails setup, registering nothing", async () => {
  const { ctx, recorded, registeredToolNames, addedStrategies } = recordCtx({
    fallback: "bogus",
  });

  await expect(plugin.setup(ctx)).rejects.toThrow(
    /invalid plugin option "fallback"/,
  );
  expect(addedStrategies).toEqual([]);
  expect(registeredToolNames).toEqual([]);
  expect(recorded.strategies).toEqual([]);
});

test("a misconfigured targetRoot fails setup, registering nothing", async () => {
  const { ctx, recorded, registeredToolNames, addedStrategies } = recordCtx({
    targetRoot: 42,
  });

  await expect(plugin.setup(ctx)).rejects.toThrow(
    /invalid plugin option "targetRoot"/,
  );
  expect(addedStrategies).toEqual([]);
  expect(registeredToolNames).toEqual([]);
  expect(recorded.strategies).toEqual([]);
});

test("a valid configuration registers both tools and the strategy", async () => {
  const { ctx, registeredToolNames, addedStrategies } = recordCtx({
    fallback: "git",
    targetRoot: "/mnt/worktrees",
  });

  await plugin.setup(ctx);

  expect(addedStrategies).toEqual(["cow"]);
  expect([...registeredToolNames].sort()).toEqual([
    "list_worktrees",
    "spawn_workspace",
  ]);
});

test.skipIf(nonCowRoot === undefined)("fallback disabled: an unsupported filesystem fails and requests no git worktree", async () => {
  const dir = await scratchDir(nonCowRoot!);
  const { tool, recorded } = await harness(undefined);

  await expect(tool.execute({ sourceDirectory: dir })).rejects.toThrow(/not supported/i);
  expect(recorded.strategies).toEqual([]);
  expect(recorded.removed).toEqual([]);
});

test.skipIf(nonCowRoot === undefined)("fallback explicitly none: the same hard error", async () => {
  const dir = await scratchDir(nonCowRoot!);
  const { tool, recorded } = await harness({ fallback: "none" });

  await expect(tool.execute({ sourceDirectory: dir })).rejects.toThrow(/not supported/i);
  expect(recorded.strategies).toEqual([]);
});

test.skipIf(nonCowRoot === undefined)("fallback enabled: the same request produces a git worktree and reports git", async () => {
  const dir = await scratchDir(nonCowRoot!);
  const { tool, recorded } = await harness({ fallback: "git" });

  const result = await tool.execute({ sourceDirectory: dir });

  expect(result.output.mechanism).toBe("git");
  expect(recorded.strategies).toEqual(["git"]);
});

test.skipIf(cowRoot === undefined)("fallback enabled does not change behavior on a CoW filesystem", async () => {
  const dir = await scratchDir(cowRoot!);
  const { tool, recorded } = await harness({ fallback: "git" });

  const result = await tool.execute({ sourceDirectory: dir });

  expect(result.output.mechanism).toBe("cow");
  expect(recorded.strategies).toEqual(["cow"]);
});

test.skipIf(cowRoot === undefined)(
  "by default the tool asks opencode2 to parent the worktree beside the source",
  async () => {
    const dir = await scratchDir(cowRoot!);
    const { tool, recorded } = await harness(undefined);

    await tool.execute({ sourceDirectory: dir, name: "worker" });

    // `Worktree.CreateInput.directory` is the parent, so the default is the
    // source's own parent — same device by construction.
    expect(recorded.parents).toEqual([join(dir, "..")]);
  },
);

test.skipIf(cowRoot === undefined)(
  "a configured targetRoot is passed through as the worktree parent",
  async () => {
    const dir = await scratchDir(cowRoot!);
    const { tool, recorded } = await harness({ targetRoot: "/mnt/worktrees" });

    await tool.execute({ sourceDirectory: dir, name: "worker" });

    expect(recorded.parents).toEqual(["/mnt/worktrees"]);
  },
);

test.skipIf(nonCowRoot === undefined)(
  "a session start failure removes the created worktree and preserves the original cause",
  async () => {
    // The cleanup runs through opencode2's DELETE route, which is best-effort.
    // The failure must survive as the original Error (identity), not be replaced
    // by whatever the cleanup did, and the binding must be exercised with the
    // directory the create actually returned.
    const dir = await scratchDir(nonCowRoot!);
    const sentinel = new Error("session sentinel");
    const { tool, recorded, createdDirs } = await harness(
      { fallback: "git" },
      { sessionCreateError: sentinel },
    );

    let rejection: unknown;
    try {
      await tool.execute({ sourceDirectory: dir });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    const error = rejection as Error;
    const worktree = createdDirs[0]!;

    expect(error.message).toMatch(new RegExp(`session start failed in ${worktree}`));
    expect(error.cause).toBe(sentinel);
    expect(recorded.removed).toEqual([worktree]);
  },
);
