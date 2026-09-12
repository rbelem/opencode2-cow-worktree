import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
}

/**
 * A fake Context whose worktree.create records the requested strategy and
 * returns a directory keyed to it, and whose options carry the fallback policy.
 * This is the smallest surface the registered tool's live bindings touch.
 */
async function harness(
  options: Record<string, unknown> | undefined,
  harnessOptions: { readonly sessionCreateError?: Error } = {},
): Promise<Harness> {
  const recorded: Recorded = { strategies: [], removed: [], parents: [] };
  let registered: RegisteredTool | undefined;

  const ctx = {
    options,
    worktree: {
      create: async (input: { strategy?: string; directory?: string }) => {
        recorded.strategies.push(input.strategy ?? "default");
        recorded.parents.push(input.directory);
        return { directory: `/worktrees/${input.strategy}-worktree` };
      },
      remove: async (input: { directory: string }) => {
        recorded.removed.push(input.directory);
      },
      transform: async (callback: (editor: { add: () => void }) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({
          add: (tool: any) => {
            registered = tool as RegisteredTool;
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

  await plugin.setup(ctx);
  if (registered === undefined) throw new Error("spawn_workspace was not registered");
  return { tool: registered, recorded };
}

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

test.skipIf(cowRoot === undefined)("an invalid fallback value fails the call loudly", async () => {
  const dir = await scratchDir(cowRoot!);
  const { tool, recorded } = await harness({ fallback: "bogus" });

  await expect(tool.execute({ sourceDirectory: dir })).rejects.toThrow(/fallback/);
  expect(recorded.strategies).toEqual([]);
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

test.skipIf(cowRoot === undefined)(
  "an invalid targetRoot fails the call loudly before any worktree is requested",
  async () => {
    const dir = await scratchDir(cowRoot!);
    const { tool, recorded } = await harness({ targetRoot: 42 });

    await expect(tool.execute({ sourceDirectory: dir })).rejects.toThrow(/targetRoot/);
    expect(recorded.strategies).toEqual([]);
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
    const { tool, recorded } = await harness(
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

    expect(error.message).toMatch(/session start failed in \/worktrees\/git-worktree/);
    expect(error.cause).toBe(sentinel);
    expect(recorded.removed).toEqual(["/worktrees/git-worktree"]);
  },
);
