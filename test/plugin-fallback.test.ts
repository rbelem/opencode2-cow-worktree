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
async function harness(options: Record<string, unknown> | undefined): Promise<Harness> {
  const recorded: Recorded = { strategies: [], removed: [] };
  let registered: RegisteredTool | undefined;

  const ctx = {
    options,
    worktree: {
      create: async (input: { strategy?: string }) => {
        recorded.strategies.push(input.strategy ?? "default");
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
    session: { create: async () => ({ id: "ses_live" }) },
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
