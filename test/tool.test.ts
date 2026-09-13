import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { probeCowCapability } from "../src/capability";
import type { CowCapability } from "../src/capability";
import type { Mechanism } from "../src/mechanism";
import { deviceOf, isDirectory, nearestExistingDevice, spawnWorkspace } from "../src/tool";
import type { SpawnWorkspaceDeps } from "../src/tool";
import plugin from "../src/plugin";
import { findCowRoot, findNonCowRoot } from "./fs-roots";

// The two tests that use a real filesystem need a CoW root; discover one
// instead of hardcoding this machine's mount, and skip cleanly without it.
const cowRoot = await findCowRoot();
const nonCowRoot = await findNonCowRoot();

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(cowRoot!, "cow-tool-"));
  scratchDirs.push(dir);
  return dir;
}

/** Records each seam call so the decision table can assert what ran. */
interface Calls {
  readonly createWorktree: Array<{
    sourceDirectory: string;
    parentDirectory: string;
    strategy: Mechanism;
    name?: string;
  }>;
  readonly createSession: Array<{ directory: string; name?: string }>;
  readonly removed: string[];
  /** How many times the inventory seam was read. */
  readonly listed: number[];
  /** Every path the isDirectory seam was asked about. */
  readonly probedDirectories: string[];
}

function fakeDeps(
  capability: CowCapability,
  options: {
    readonly fallback?: "none" | "git";
    readonly failSession?: boolean;
    readonly targetRoot?: string;
    /** Devices keyed by the exact path the tool probes; absent means "unknown". */
    readonly devices?: Readonly<Record<string, number>>;
    /** Inventory rows `listWorktrees` reports; absent means an empty inventory. */
    readonly inventory?: ReadonlyArray<{ directory: string; strategy?: string }>;
    /** Paths `isDirectory` answers true for; every other path is "no". */
    readonly directories?: readonly string[];
  } = {},
): { deps: SpawnWorkspaceDeps; calls: Calls } {
  const calls: Calls = {
    createWorktree: [],
    createSession: [],
    removed: [],
    listed: [],
    probedDirectories: [],
  };
  const deps: SpawnWorkspaceDeps = {
    probe: async () => capability,
    probeDevice: async (path) => options.devices?.[path],
    listWorktrees: async () => {
      calls.listed.push(1);
      return options.inventory ?? [];
    },
    isDirectory: async (path) => {
      calls.probedDirectories.push(path);
      return options.directories?.includes(path) ?? false;
    },
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
    targetRoot: options.targetRoot,
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
    {
      sourceDirectory: "/src",
      parentDirectory: join("/src", ".."),
      strategy: "cow",
      name: "worker",
    },
  ]);
  expect(calls.createSession).toEqual([{ directory: "/worktrees/cow-clone", name: "worker" }]);
  expect(calls.removed).toEqual([]);
});

test("the default parent is a sibling of the source, on the source's device", async () => {
  const { deps, calls } = fakeDeps({ status: "supported" });
  await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  // A sibling shares the source's filesystem by construction, which is what a
  // CoW clone requires; opencode2 appends the name below this parent.
  expect(calls.createWorktree[0]?.parentDirectory).toBe(join("/src", ".."));
});

test("a configured target root is honoured as the worktree parent", async () => {
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    { targetRoot: "/mnt/same-device" },
  );
  await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(calls.createWorktree[0]?.parentDirectory).toBe("/mnt/same-device");
});

test("a configured target root on another device fails, naming the mismatch", async () => {
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/mnt/other-device",
      devices: { "/src": 60, "/mnt/other-device": 43 },
    },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/different filesystem.*cannot cross devices/i);
  // The failure is decided before the create is attempted: nothing to clean up.
  expect(calls.createWorktree).toEqual([]);
});

test("a same-device configured target root proceeds", async () => {
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/mnt/other-device",
      devices: { "/src": 60, "/mnt/other-device": 60 },
    },
  );
  await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(calls.createWorktree[0]?.parentDirectory).toBe("/mnt/other-device");
});

test("an unknown device on either side is not treated as a mismatch", async () => {
  // `probeDevice` returning undefined (path not yet created / unreadable) must
  // not fabricate a cross-device error; the create proceeds.
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    { targetRoot: "/mnt/other-device", devices: { "/src": 60 } },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.mechanism).toBe("cow");
  expect(calls.createWorktree).toHaveLength(1);
});

test("the cross-device guard does not apply to the git mechanism", async () => {
  // `git` builds a Shallow worktree without shared extents; a different device
  // is not an obstacle, so the guard is `cow`-only.
  const { deps, calls } = fakeDeps(
    { status: "unsupported" },
    {
      fallback: "git",
      targetRoot: "/mnt/other-device",
      devices: { "/src": 60, "/mnt/other-device": 43 },
    },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.mechanism).toBe("git");
  expect(calls.createWorktree[0]?.parentDirectory).toBe("/mnt/other-device");
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

// Attach (issue #1): a named Worktree that already exists is attached to, not
// recreated — and only when the inventory says it is ours and the directory
// carries the Deep-clone signature. Every other occupant of the predicted path
// is refused before any session or filesystem change.
test("an existing cow Deep clone under the predicted name is attached to, not recreated", async () => {
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: target, strategy: "cow" }],
      directories: [target, join(target, ".git")],
    },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result).toEqual({
    sessionID: "ses_test",
    directory: target,
    mechanism: "cow",
    attached: true,
  });
  expect(calls.createWorktree).toEqual([]);
  expect(calls.createSession).toEqual([{ directory: target, name: "worker" }]);
  expect(calls.removed).toEqual([]);
  // The Deep-clone signature was checked on the found directory, not assumed.
  expect(calls.probedDirectories).toContain(join(target, ".git"));
});

test("attach is decided before the capability probe: no clone question is asked", async () => {
  // An `error` capability throws in the create flow; reaching attach proves
  // the attach branch short-circuits the probe, because attach attempts no
  // clone and the source's capability is not its question to ask.
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "error", error: new Error("EACCES") },
    {
      targetRoot: "/wt",
      inventory: [{ directory: target, strategy: "cow" }],
      directories: [target, join(target, ".git")],
    },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.attached).toBe(true);
  expect(calls.createWorktree).toEqual([]);
});

test("attach predicts the same sibling parent the create flow uses when no root is set", async () => {
  const target = join("/src", "..", "worker");
  const { deps, calls } = fakeDeps({ status: "supported" }, {
    inventory: [{ directory: target, strategy: "cow" }],
    directories: [target, join(target, ".git")],
  });
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.directory).toBe(target);
  expect(calls.createWorktree).toEqual([]);
});

test("a same-named worktree of another strategy is refused, naming the strategy and directory", async () => {
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: target, strategy: "git" }],
      directories: [target, join(target, ".git")],
    },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/refusing to attach to \/wt\/worker.*records it with "git", not "cow"/);
  expect(calls.createWorktree).toEqual([]);
  expect(calls.createSession).toEqual([]);
  expect(calls.removed).toEqual([]);
});

test("a strategy-less inventory row (the checkout root) is also refused", async () => {
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: target }],
      directories: [target, join(target, ".git")],
    },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/records it with no strategy, not "cow"/);
  expect(calls.createSession).toEqual([]);
});

test("an existing path absent from the inventory is refused as a Foreign worktree", async () => {
  const target = "/wt/stranger";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    { targetRoot: "/wt", inventory: [], directories: [target] },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "stranger" }, deps),
  ).rejects.toThrow(
    /refusing to attach to \/wt\/stranger: the path exists but.*Foreign worktree/,
  );
  expect(calls.createWorktree).toEqual([]);
  expect(calls.createSession).toEqual([]);
});

test("a cow inventory row without the Deep-clone signature is refused", async () => {
  // The inventory says cow, but `.git` is not a directory: the row is stale or
  // the directory was replaced, so the attach evidence is not there.
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: target, strategy: "cow" }],
      directories: [target],
    },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/records strategy "cow", but .*\.git is not a directory/);
  expect(calls.createSession).toEqual([]);
});

test("attach refuses before the session even when the existing worktree would be removable", async () => {
  // The refusal path must not run removeWorktree "to make room": the directory
  // is not ours to delete.
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    { targetRoot: "/wt", inventory: [{ directory: target, strategy: "git" }], directories: [target] },
  );

  await expect(spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps)).rejects.toThrow(
    /refusing to attach/,
  );
  expect(calls.removed).toEqual([]);
});

test("a failed session start on attach does not remove the existing worktree", async () => {
  const target = "/wt/worker";
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      failSession: true,
      inventory: [{ directory: target, strategy: "cow" }],
      directories: [target, join(target, ".git")],
    },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/session start failed in existing worktree \/wt\/worker/);
  expect(calls.removed).toEqual([]);
});

test("a named worktree whose predicted path is free takes the create flow unchanged", async () => {
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    { targetRoot: "/wt", inventory: [{ directory: "/wt/other", strategy: "cow" }] },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.attached).toBeUndefined();
  expect(calls.createWorktree).toHaveLength(1);
  expect(calls.createSession).toHaveLength(1);
  // The target was probed, found absent, and the inventory never read.
  expect(calls.probedDirectories).toEqual(["/wt/worker"]);
  expect(calls.listed).toEqual([]);
});

test("an unnamed spawn never probes for an attach", async () => {
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: "/wt/generated-1", strategy: "cow" }],
      directories: ["/wt/generated-1"],
    },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src" }, deps);

  expect(result.attached).toBeUndefined();
  expect(calls.probedDirectories).toEqual([]);
  expect(calls.listed).toEqual([]);
  expect(calls.createWorktree).toHaveLength(1);
});

test.skipIf(cowRoot === undefined)(
  "isDirectory distinguishes a directory, a file, and a missing path",
  async () => {
    const dir = await scratchDir();
    const file = join(dir, "a-file");
    await writeFile(file, "x");
    expect(await isDirectory(dir)).toBe(true);
    expect(await isDirectory(file)).toBe(false);
    expect(await isDirectory(join(dir, "missing"))).toBe(false);
  },
);

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

test.skipIf(cowRoot === undefined)("the real capability probe drives the decision on a btrfs directory", async () => {
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

test.skipIf(cowRoot === undefined || nonCowRoot === undefined)(
  "a real target root on a different filesystem is rejected as a device mismatch",
  async () => {
    // A real CoW source on one filesystem and a real non-CoW directory on
    // another — the runner's mounts, discovered, never hardcoded. The two roots
    // necessarily differ in device; the guard must name that, not surface EXDEV.
    const source = await scratchDir();
    const target = await mkdtemp(join(nonCowRoot!, "cow-tool-target-"));
    scratchDirs.push(target);

    expect(await deviceOf(source)).not.toBe(await deviceOf(target));

    const { deps, calls } = fakeDeps({ status: "supported" }, { targetRoot: target });
    await expect(
      spawnWorkspace(
        { sourceDirectory: source, name: "worker" },
        { ...deps, probe: probeCowCapability, probeDevice: deviceOf },
      ),
    ).rejects.toThrow(/different filesystem.*cannot cross devices/i);
    expect(calls.createWorktree).toEqual([]);
  },
);

test.skipIf(cowRoot === undefined)(
  "the default parent lands the target on the source's own device",
  async () => {
    const source = await scratchDir();
    const { deps, calls } = fakeDeps({ status: "supported" });
    await spawnWorkspace(
      { sourceDirectory: source, name: "worker" },
      { ...deps, probe: probeCowCapability, probeDevice: deviceOf },
    );

    const parent = calls.createWorktree[0]!.parentDirectory;
    expect(await deviceOf(parent)).toBe(await deviceOf(source));
  },
);

test.skipIf(cowRoot === undefined)("plugin setup registers the spawn_workspace tool behind the tool seam", async () => {
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

test("nearestExistingDevice terminates at the root: its parent is itself", async () => {
  // The walk climbs to `/`, whose parent is itself, so a probe that never
  // reports a device returns undefined rather than looping forever.
  expect(await nearestExistingDevice("/", async () => undefined)).toBeUndefined();
});

test("nearestExistingDevice climbs past unreadable ancestors to the first device", async () => {
  // The leaf and its parent are unreadable; `/` answers. This drives the loop
  // back edge, so the walk is known to climb rather than only terminate.
  const probed: string[] = [];
  const device = await nearestExistingDevice("/missing/leaf", async (path) => {
    probed.push(path);
    return path === "/" ? 42 : undefined;
  });

  expect(device).toBe(42);
  expect(probed).toEqual(["/missing/leaf", "/missing", "/"]);
});

// Two registration defects the e2e simulation found (#9). Both are invisible to
// a fake ctx that only checks the tool executes, so they are asserted here on
// the registration itself.
test("the registered tool is kept on the native tool list, not behind CodeMode", async () => {
  const registered: Array<{ name: string; options?: { codemode?: boolean } }> = [];

  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string; options?: { codemode?: boolean } }) => registered.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);

  const tool = registered.find((entry) => entry.name === "spawn_workspace");
  expect(tool).toBeDefined();
  // Unset defaults into CodeMode, where the model only sees `execute`.
  expect(tool!.options?.codemode).toBe(false);
});

test("the registered tool declares the output schema it returns", async () => {
  const registered: Array<{ name: string; output?: unknown }> = [];

  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string; output?: unknown }) => registered.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);

  const tool = registered.find((entry) => entry.name === "spawn_workspace");
  expect(tool).toBeDefined();
  // A result with an `output` field and no declared schema is a hard defect in
  // opencode2, not a recoverable error.
  expect(tool!.output).toBeDefined();
  expect((tool!.output as { required?: string[] }).required).toEqual([
    "sessionID",
    "directory",
    "mechanism",
  ]);
});

// The attach path through the live ctx bindings: the tool must read the
// inventory through ctx.worktree.list, check the real filesystem, start the
// session in the found directory, and say "Attached" rather than "Created".
test("the registered tool attaches through ctx.worktree.list and reports it", async () => {
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
  }> = [];
  const dir = await scratchDir();
  // A real existing cow worktree beside the source: the Deep-clone check is
  // wired to the real filesystem, so the directory and its `.git` must exist.
  const target = join(dir, "..", "att");
  scratchDirs.push(target);
  await mkdir(join(target, ".git"), { recursive: true });

  let created = 0;
  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => [{ directory: target, strategy: "cow" }],
      create: async () => {
        created += 1;
        return { directory: target };
      },
      remove: async () => {},
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: {
            name: string;
            execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
          }) => {
            registered.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: { create: async () => ({ id: "ses_attach" }) },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  const tool = registered.find((entry) => entry.name === "spawn_workspace");
  expect(tool).toBeDefined();

  const result = await tool!.execute({ sourceDirectory: dir, name: "att" });
  expect(result.output).toEqual({
    sessionID: "ses_attach",
    directory: target,
    mechanism: "cow",
    attached: true,
  });
  expect(result.content).toContain(`Attached to existing cow worktree at ${target}`);
  expect(result.content).toContain("no new worktree was created");
  expect(created).toBe(0);
});
