import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { probeCowCapability } from "../src/capability";
import type { CowCapability } from "../src/capability";
import type { Mechanism } from "../src/mechanism";
import { spawnWorkspace } from "../src/tool";
import type { SpawnWorkspaceDeps } from "../src/tool";
import plugin from "../src/plugin";

// Real CoW filesystem: the machine's /home (and /) is btrfs.
const COW_ROOT = "/tmp/opencode";

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(COW_ROOT, "cow-tool-"));
  scratchDirs.push(dir);
  return dir;
}

/** Records each seam call so the decision table can assert what ran. */
interface Calls {
  readonly createWorktree: Array<{ sourceDirectory: string; strategy: Mechanism; name?: string }>;
  readonly createSession: Array<{ directory: string; name?: string }>;
  readonly removed: string[];
}

function fakeDeps(
  capability: CowCapability,
  options: {
    readonly fallback?: "none" | "git";
    readonly failSession?: boolean;
  } = {},
): { deps: SpawnWorkspaceDeps; calls: Calls } {
  const calls: Calls = { createWorktree: [], createSession: [], removed: [] };
  const deps: SpawnWorkspaceDeps = {
    probe: async () => capability,
    createWorktree: async (input) => {
      calls.createWorktree.push(input);
      return { directory: `/worktrees/${input.strategy}-clone` };
    },
    createSession: async (directory, name) => {
      calls.createSession.push({ directory, name });
      if (options.failSession) throw new Error("session boom");
      return "ses_test";
    },
    removeWorktree: async (directory) => {
      calls.removed.push(directory);
    },
    fallback: options.fallback,
  };
  return { deps, calls };
}

test("supported + fallback none creates a cow clone and starts a session in it", async () => {
  const { deps, calls } = fakeDeps({ status: "supported" });
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result).toEqual({
    sessionID: "ses_test",
    directory: "/worktrees/cow-clone",
    mechanism: "cow",
  });
  expect(calls.createWorktree).toEqual([
    { sourceDirectory: "/src", strategy: "cow", name: "worker" },
  ]);
  expect(calls.createSession).toEqual([{ directory: "/worktrees/cow-clone", name: "worker" }]);
  expect(calls.removed).toEqual([]);
});

test("unsupported + fallback none rejects and creates nothing", async () => {
  const { deps, calls } = fakeDeps({ status: "unsupported" });

  await expect(spawnWorkspace({ sourceDirectory: "/src" }, deps)).rejects.toThrow(
    /not supported.*fallback/i,
  );
  expect(calls.createWorktree).toEqual([]);
  expect(calls.createSession).toEqual([]);
});

test("supported + fallback git still reports cow: the probe decides, not the policy", async () => {
  const { deps, calls } = fakeDeps({ status: "supported" }, { fallback: "git" });
  const result = await spawnWorkspace({ sourceDirectory: "/src" }, deps);

  expect(result.mechanism).toBe("cow");
  expect(calls.createWorktree[0]?.strategy).toBe("cow");
});

test("unsupported + fallback git produces a git worktree", async () => {
  const { deps, calls } = fakeDeps({ status: "unsupported" }, { fallback: "git" });
  const result = await spawnWorkspace({ sourceDirectory: "/src" }, deps);

  expect(result.mechanism).toBe("git");
  expect(result.directory).toBe("/worktrees/git-clone");
  expect(calls.createWorktree[0]?.strategy).toBe("git");
});

test("error + fallback none rejects", async () => {
  const { deps, calls } = fakeDeps({ status: "error", error: new Error("EACCES") });

  await expect(spawnWorkspace({ sourceDirectory: "/src" }, deps)).rejects.toThrow(
    /capability probe failed/i,
  );
  expect(calls.createWorktree).toEqual([]);
});

test("error + fallback git rejects: a probe error is not a capability negative", async () => {
  const { deps, calls } = fakeDeps(
    { status: "error", error: new Error("ENOENT") },
    { fallback: "git" },
  );

  await expect(spawnWorkspace({ sourceDirectory: "/src" }, deps)).rejects.toThrow(
    /capability probe failed/i,
  );
  expect(calls.createWorktree).toEqual([]);
});

test("session creation failure removes the worktree and propagates the error", async () => {
  const { deps, calls } = fakeDeps({ status: "supported" }, { failSession: true });

  await expect(spawnWorkspace({ sourceDirectory: "/src" }, deps)).rejects.toThrow(
    /session start failed/i,
  );
  expect(calls.removed).toEqual(["/worktrees/cow-clone"]);
});

test("the reported mechanism always equals the strategy that produced the directory", async () => {
  for (const capability of [
    { status: "supported" } as const,
    { status: "unsupported" } as const,
  ]) {
    const { deps, calls } = fakeDeps(capability, { fallback: "git" });
    const result = await spawnWorkspace({ sourceDirectory: "/src" }, deps);
    expect(result.mechanism).toBe(calls.createWorktree[0]!.strategy);
  }
});

test("the real capability probe drives the decision on a btrfs directory", async () => {
  const dir = await scratchDir();
  const capability = await probeCowCapability(dir);
  expect(capability.status).toBe("supported");

  const { deps, calls } = fakeDeps(capability);
  // Replace only the probe with the real one; the rest stay fakes.
  const result = await spawnWorkspace(
    { sourceDirectory: dir },
    { ...deps, probe: probeCowCapability },
  );

  expect(result.mechanism).toBe("cow");
  expect(calls.createWorktree[0]?.strategy).toBe("cow");
});

test("plugin setup registers the spawn_workspace tool behind the tool seam", async () => {
  const registered: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> = [];
  const worktreeCreate = async (input: { strategy?: string }) => ({
    directory: `/worktrees/${input.strategy}-clone`,
  });
  const sessionCreate = async () => ({ id: "ses_live" });
  const dir = await scratchDir();

  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      create: worktreeCreate,
      remove: async () => {},
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string; execute: (input: unknown) => Promise<unknown> }) => {
            registered.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: { create: sessionCreate },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);

  const tool = registered.find((entry) => entry.name === "spawn_workspace");
  expect(tool).toBeDefined();
  // Drive the registered tool end-to-end through the live ctx bindings.
  const result = (await tool!.execute({ sourceDirectory: dir })) as {
    output: { mechanism: string; directory: string; sessionID: string };
  };
  expect(result.output.mechanism).toBe("cow");
  expect(result.output.directory).toBe("/worktrees/cow-clone");
  expect(result.output.sessionID).toBe("ses_live");
});
