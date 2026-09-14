import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { probeCowCapability } from "../src/capability";
import type { CowCapability } from "../src/capability";
import type { Mechanism } from "../src/mechanism";
import { deviceOf, isDirectory, nearestExistingDevice } from "../src/device";
import type { SessionGetResult } from "../types/opencode2-worktree";
import { listCowWorktrees, spawnWorkspace } from "../src/tool";
import type {
  CowWorktreeEntry,
  ListWorktreesDeps,
  SpawnWorkspaceDeps,
  SpawnWorkspaceResult,
} from "../src/tool";
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
  /** Every session id the occupancy probe looked up. */
  readonly sessionLookups: string[];
  /** Every marker write the guard performed. */
  readonly markerWrites: Array<{ directory: string; sessionID: string }>;
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
    /** Raw marker content `readMarker` reports for every directory; none by default. */
    readonly marker?: string;
    /** What `sessionGet` resolves to; absent means the id is not found. */
    readonly sessionAnswer?: SessionGetResult | undefined;
    /** Makes `sessionGet` throw instead. */
    readonly sessionGetError?: Error;
    /** The epoch `now()` reports; defaults to a fixed instant. */
    readonly now?: number;
    /** Makes `writeMarker` throw, exercising the warning path. */
    readonly failMarkerWrite?: boolean;
  } = {},
): { deps: SpawnWorkspaceDeps; calls: Calls } {
  const calls: Calls = {
    createWorktree: [],
    createSession: [],
    removed: [],
    listed: [],
    probedDirectories: [],
    sessionLookups: [],
    markerWrites: [],
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
    sessionGet: async (id) => {
      calls.sessionLookups.push(id);
      if (options.sessionGetError !== undefined) throw options.sessionGetError;
      // The seam's declared shape is total; a not-found answer rides in as
      // undefined and the classifier reads it as a positive absence.
      return options.sessionAnswer as SessionGetResult;
    },
    readMarker: async () => options.marker,
    writeMarker: async (directory, sessionID) => {
      if (options.failMarkerWrite) throw new Error("marker fs boom");
      calls.markerWrites.push({ directory, sessionID });
    },
    now: () => options.now ?? 1_000_000,
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

test.skipIf(cowRoot === undefined)("attach never runs the post-create hooks (ticket 05)", async () => {
  // The hooks belong to the strategy's create flow; attach binds a session to
  // a directory that already exists and clones nothing. The plugin wires a
  // hook that would fail any create (`exit 1`), and the worktree seam is
  // poisoned to reject any create request — attach succeeding through the
  // registered tool is the proof the hooks never ran.
  const registered: Array<{
    name: string;
    execute: (input: { sourceDirectory: string; name?: string }) => Promise<{
      output: { attached?: boolean };
    }>;
  }> = [];
  const dir = await scratchDir();
  const target = join(dir, "..", "att-hooks");
  scratchDirs.push(target);
  await mkdir(join(target, ".git"), { recursive: true });

  const ctx = {
    options: { hooks: { postCreate: ["exit 1"] } },
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => [{ directory: target, strategy: "cow" }],
      create: async () => {
        throw new Error("attach must never request a create");
      },
      remove: async () => {},
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({
          add: (tool: any) => {
            if (tool.name === "spawn_workspace") registered.push(tool);
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

  const result = await tool!.execute({ sourceDirectory: dir, name: "att-hooks" });
  expect(result.output.attached).toBe(true);
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

test.skipIf(cowRoot === undefined)(
  "attach matches an inventory row that names the same directory through a different spelling",
  async () => {
    // The inventory may record the worktree through a path that is not the
    // predicted spelling — here an alternate parent whose `worker` entry is a
    // symlink to the worktree: same basename, lexically unrelated, and only
    // realpath equates the two. An exact-string comparison alone would refuse
    // a real cow worktree as Foreign.
    const root = await scratchDir();
    const source = join(root, "source");
    await mkdir(source);
    const target = join(root, "worker");
    await mkdir(join(target, ".git"), { recursive: true });
    const alt = join(root, "alt");
    await mkdir(alt);
    const spelled = join(alt, "worker");
    await symlink(target, spelled);

    const { deps, calls } = fakeDeps(
      { status: "supported" },
      { inventory: [{ directory: spelled, strategy: "cow" }] },
    );
    const result = await spawnWorkspace(
      { sourceDirectory: source, name: "worker" },
      { ...deps, isDirectory },
    );

    expect(result).toEqual({
      sessionID: "ses_test",
      directory: target,
      mechanism: "cow",
      attached: true,
    });
    expect(calls.createWorktree).toEqual([]);
  },
);

test("an inventory row equal only after lexical normalization still matches", async () => {
  // Neither path exists on a real filesystem here, so realpath is unavailable
  // and identity falls back to lexical normalization: the `..` segment
  // cancels out and the row is recognized as ours.
  const target = "/wt/worker";
  const spelled = join("/wt", "..", "wt", "worker");
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: spelled, strategy: "cow" }],
      directories: [target, join(target, ".git")],
    },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.attached).toBe(true);
  expect(calls.createWorktree).toEqual([]);
});

test("a same-basename row for a different directory is still no entry: Foreign", async () => {
  // Fail closed: the basename matches, but neither comparison equates the two
  // paths, so the row is not the predicted directory and the attach refuses.
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: "/wt/nested/worker", strategy: "cow" }],
      directories: ["/wt/worker"],
    },
  );

  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/Foreign worktree/);
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

// ---------------------------------------------------------------------------
// Occupancy guard (issue #15), driven through spawnWorkspace's attach and
// create flows. The pure decision table itself is pinned in
// test/occupancy.test.ts; these pin where the guard sits in the flow.
// ---------------------------------------------------------------------------

/** An attach fixture: a cow Deep clone under the predicted name, ready to attach. */
function attachFixture(marker?: string): {
  deps: SpawnWorkspaceDeps;
  calls: Calls;
} {
  return fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: "/wt/worker", strategy: "cow" }],
      directories: ["/wt/worker", join("/wt/worker", ".git")],
      marker,
      sessionAnswer: { id: "ses_old", time: { updated: 500 } },
    },
  );
}

test("attach refuses while the marker's session is fresh, naming it and the recoveries", async () => {
  const { deps, calls } = attachFixture('{"sessionID":"ses_old"}');
  // now 1_000_000, updated 500: well inside the occupancy window.
  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/refusing to attach to \/wt\/worker.*session ses_old/);
  expect(calls.sessionLookups).toEqual(["ses_old"]);
  expect(calls.createSession).toEqual([]);
  expect(calls.markerWrites).toEqual([]);
});

test("a fresh refusal spells out all three recoveries", async () => {
  const { deps } = attachFixture('{"sessionID":"ses_old"}');
  let message = "";
  try {
    await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);
  } catch (cause) {
    message = (cause as Error).message;
  }
  expect(message).toContain("Pick another worktree name");
  expect(message).toContain("DELETE /api/session/<sessionID>");
  expect(message).toContain("remove the occupancy marker");
});

test("attach proceeds and rewrites when the marker's session is gone (404)", async () => {
  // Both 404 shapes the live binding can produce: a plain not-found answer and
  // the thrown `SessionNotFoundError`. Each proves the marker stale, so the
  // attach runs and the marker is rewritten for the new session.
  const notFound = fakeDeps({ status: "supported" }, {
    targetRoot: "/wt",
    inventory: [{ directory: "/wt/worker", strategy: "cow" }],
    directories: ["/wt/worker", join("/wt/worker", ".git")],
    marker: '{"sessionID":"ses_old"}',
    sessionAnswer: undefined,
  });
  const thrown = fakeDeps({ status: "supported" }, {
    targetRoot: "/wt",
    inventory: [{ directory: "/wt/worker", strategy: "cow" }],
    directories: ["/wt/worker", join("/wt/worker", ".git")],
    marker: '{"sessionID":"ses_old"}',
    sessionGetError: Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" }),
  });

  const answered = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, notFound.deps);
  const thrown404 = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, thrown.deps);

  expect(answered.attached).toBe(true);
  expect(thrown404.attached).toBe(true);
  expect(notFound.calls.markerWrites).toEqual([{ directory: "/wt/worker", sessionID: "ses_test" }]);
  expect(thrown.calls.markerWrites).toEqual([{ directory: "/wt/worker", sessionID: "ses_test" }]);
});

test("a malformed marker refuses before any session lookup", async () => {
  const { deps, calls } = attachFixture("{not json");
  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/malformed.*holder is unknown.*Pick another worktree name/s);
  expect(calls.sessionLookups).toEqual([]);
  expect(calls.createSession).toEqual([]);
});

test("a session lookup that fails for another reason refuses (not a positive absence)", async () => {
  const { deps } = fakeDeps({ status: "supported" }, {
    targetRoot: "/wt",
    inventory: [{ directory: "/wt/worker", strategy: "cow" }],
    directories: ["/wt/worker", join("/wt/worker", ".git")],
    marker: '{"sessionID":"ses_old"}',
    sessionGetError: new Error("503 upstream"),
  });
  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/could not be checked/);
});

test("a 200 whose time.updated is missing refuses instead of going dormant", async () => {
  // The classifier maps the unusable record to a probe error, so the refusal
  // is the fail-closed one — never the dormant proceed.
  const { deps } = fakeDeps({ status: "supported" }, {
    targetRoot: "/wt",
    inventory: [{ directory: "/wt/worker", strategy: "cow" }],
    directories: ["/wt/worker", join("/wt/worker", ".git")],
    marker: '{"sessionID":"ses_old"}',
    sessionAnswer: { id: "ses_old" } as SessionGetResult,
  });
  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps),
  ).rejects.toThrow(/refusing to attach.*could not be checked/s);
  const dormant = fakeDeps({ status: "supported" }, {
    targetRoot: "/wt",
    inventory: [{ directory: "/wt/worker", strategy: "cow" }],
    directories: ["/wt/worker", join("/wt/worker", ".git")],
    marker: '{"sessionID":"ses_old"}',
    sessionAnswer: { id: "ses_old", time: { updated: Number.NaN } } as SessionGetResult,
  });
  await expect(
    spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, dormant.deps),
  ).rejects.toThrow(/refusing to attach/);
});

test("a worktree with no marker attaches as before and comes out marked", async () => {
  const { deps, calls } = attachFixture(undefined);
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, deps);

  expect(result.attached).toBe(true);
  // No marker means no session to probe: the legacy path asks nothing.
  expect(calls.sessionLookups).toEqual([]);
  expect(calls.markerWrites).toEqual([{ directory: "/wt/worker", sessionID: "ses_test" }]);
});

test("the create flow writes the marker for cow and never for git", async () => {
  const cow = fakeDeps({ status: "supported" });
  await spawnWorkspace({ sourceDirectory: "/src" }, cow.deps);
  expect(cow.calls.markerWrites).toEqual([
    { directory: "/worktrees/cow-clone", sessionID: "ses_test" },
  ]);

  const git = fakeDeps({ status: "unsupported" }, { fallback: "git" });
  await spawnWorkspace({ sourceDirectory: "/src" }, git.deps);
  expect(git.calls.markerWrites).toEqual([]);
});

test("the create flow overwrites an inherited marker unconditionally", async () => {
  // A marker inherited into a fresh clone (or left by anything else) is
  // replaced, never consulted: the new session is the holder now.
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    { marker: '{"sessionID":"ses_from_source"}' },
  );
  await spawnWorkspace({ sourceDirectory: "/src" }, deps);

  expect(calls.markerWrites).toEqual([
    { directory: "/worktrees/cow-clone", sessionID: "ses_test" },
  ]);
  // The create path never probes the inherited marker's session.
  expect(calls.sessionLookups).toEqual([]);
});

test("a marker-write failure becomes markerWarning and the call still succeeds", async () => {
  const attach = attachFixture(undefined);
  attach.deps = { ...attach.deps, writeMarker: async () => {
    throw new Error("marker fs boom");
  } };
  const attached = await spawnWorkspace({ sourceDirectory: "/src", name: "worker" }, attach.deps);
  expect(attached.attached).toBe(true);
  expect(attached.markerWarning).toContain("marker fs boom");

  const created = fakeDeps({ status: "supported" }, { failMarkerWrite: true });
  const result = await spawnWorkspace({ sourceDirectory: "/src" }, created.deps);
  expect(result.mechanism).toBe("cow");
  expect(result.markerWarning).toContain("marker fs boom");
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

test("an empty-string name is not a name: create path, never probes for an attach", async () => {
  // Pins the `if (name)` guard: "" is falsy, so the whole attach preflight —
  // the name validation, the existence probe, the inventory read — never runs.
  const { deps, calls } = fakeDeps(
    { status: "supported" },
    {
      targetRoot: "/wt",
      inventory: [{ directory: "/wt/worker", strategy: "cow" }],
      directories: ["/wt/worker", join("/wt/worker", ".git")],
    },
  );
  const result = await spawnWorkspace({ sourceDirectory: "/src", name: "" }, deps);

  expect(result.attached).toBeUndefined();
  expect(calls.probedDirectories).toEqual([]);
  expect(calls.listed).toEqual([]);
  expect(calls.createWorktree).toHaveLength(1);
  expect(calls.createSession).toEqual([{ directory: "/worktrees/cow-clone", name: "" }]);
});

test("a name that is not a simple directory name is rejected before any probe", async () => {
  // Separator, dot, and dot-dot names can never be the predicted single
  // directory; the refusal must come before the existence probe or the
  // inventory read, loudly, with nothing touched.
  for (const name of ["a/b", "a\\b", ".", ".."]) {
    const { deps, calls } = fakeDeps(
      { status: "supported" },
      {
        targetRoot: "/wt",
        inventory: [{ directory: "/wt/worker", strategy: "cow" }],
        directories: ["/wt/worker", join("/wt/worker", ".git")],
      },
    );
    await expect(spawnWorkspace({ sourceDirectory: "/src", name }, deps)).rejects.toThrow(
      /only simple directory names/,
    );
    expect(calls.probedDirectories).toEqual([]);
    expect(calls.listed).toEqual([]);
    expect(calls.createWorktree).toEqual([]);
    expect(calls.createSession).toEqual([]);
    expect(calls.removed).toEqual([]);
  }
});

test("isDirectory distinguishes a directory, a file, and a missing path", async () => {
  // The live binding is plain `stat` (src/device.ts): a real directory, file,
  // and missing path are all it asks for, so no CoW filesystem is needed and
  // this never skips.
  const dir = await mkdtemp(join(tmpdir(), "cow-tool-isdir-"));
  scratchDirs.push(dir);
  const file = join(dir, "a-file");
  await writeFile(file, "x");
  expect(await isDirectory(dir)).toBe(true);
  expect(await isDirectory(file)).toBe(false);
  expect(await isDirectory(join(dir, "missing"))).toBe(false);
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
  // The cow create writes its occupancy marker into the returned directory, so
  // the fake hands back the real scratch dir instead of an invented path.
  const dir = await scratchDir();
  const worktreeCreate = async (input: { strategy?: string }) => ({
    directory: dir,
  });
  const sessionCreate = async () => ({ id: "ses_live" });

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
  expect(result.output.directory).toBe(dir);
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

// ---------------------------------------------------------------------------
// Output-contract drift pins (ticket 10).
//
// The tool output schemas in src/plugin.ts are hand-maintained: the v1
// package constraint forbids generating a JSON Schema from a TS type at
// runtime. Nothing structural stops the schema and the result types from
// drifting apart, so these pins hold each schema's `properties` and
// `required` against a canonical value of the type it declares.
// ---------------------------------------------------------------------------

/** Reads the object-schema slice of a registered tool's declared output. */
function schemaOf(output: unknown): {
  properties: Record<string, unknown>;
  required: readonly string[];
} {
  const schema = output as {
    properties: Record<string, unknown>;
    required: readonly string[];
  };
  expect(schema.properties).toBeInstanceOf(Object);
  expect(Array.isArray(schema.required)).toBe(true);
  return schema;
}

/** Registers both tools against a minimal fake ctx and returns their outputs. */
async function registeredOutputs(): Promise<Map<string, unknown>> {
  const registered: Array<{ name: string; output?: unknown }> = [];
  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({
          add: (tool: any) => {
            registered.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  return new Map(registered.map((tool) => [tool.name, tool.output]));
}

test("spawn_workspace's output schema is pinned to SpawnWorkspaceResult's keys", async () => {
  const outputs = await registeredOutputs();
  const schema = schemaOf(outputs.get("spawn_workspace"));

  // The create result's keys are exactly the schema's `required`, and the
  // attach result's keys — `attached` is the optional attach marker,
  // `markerWarning` the optional demoted write failure — are exactly the
  // schema's `properties`.
  const created: SpawnWorkspaceResult = {
    sessionID: "ses_x",
    directory: "/wt/x",
    mechanism: "cow",
  };
  const attached: SpawnWorkspaceResult = { ...created, attached: true, markerWarning: "w" };
  expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(attached).sort());
  expect([...schema.required].sort()).toEqual(Object.keys(created).sort());
});

test("list_worktrees's entry schema is pinned to CowWorktreeEntry's keys", async () => {
  const outputs = await registeredOutputs();
  const entrySchema = schemaOf(
    (schemaOf(outputs.get("list_worktrees")).properties.worktrees as {
      items: unknown;
    }).items,
  );

  const entry: CowWorktreeEntry = {
    name: "worker",
    directory: "/wt/worker",
    strategy: "cow",
    createdAt: new Date(0).toISOString(),
  };
  expect(Object.keys(entrySchema.properties).sort()).toEqual(Object.keys(entry).sort());
  expect([...entrySchema.required].sort()).toEqual(Object.keys(entry).sort());
});

// The attach path through the live ctx bindings: the tool must read the
// inventory through ctx.worktree.list, check the real filesystem, start the
// session in the found directory, and say "Attached" rather than "Created".
test("the registered tool attaches through ctx.worktree.list and reports it", async () => {
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
  }> = [];
  // The attach path consults the real filesystem only for the Deep-clone
  // signature (`<target>` and `<target>/.git` being directories) — attach
  // attempts no clone, so it never probes CoW capability (src/tool.ts). A
  // plain writable directory is a faithful fixture, and the test runs — rather
  // than skips — on non-CoW machines too.
  const dir = await mkdtemp(join(tmpdir(), "cow-tool-att-"));
  scratchDirs.push(dir);
  // A real directory carrying the Deep-clone signature, beside the source; the
  // inventory row below is what says "cow".
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

// The occupancy guard through the live ctx bindings (issue #15): a real
// marker file on disk, `ctx.session.get` answering through the fake context.
test("the registered tool refuses to attach while the marker's session is live", async () => {
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
  }> = [];
  const dir = await mkdtemp(join(tmpdir(), "cow-tool-occ-"));
  scratchDirs.push(dir);
  const target = join(dir, "..", "occ");
  scratchDirs.push(target);
  await mkdir(join(target, ".git"), { recursive: true });
  await writeFile(
    join(target, ".cow-session.json"),
    JSON.stringify({ sessionID: "ses_marked", startedAt: new Date().toISOString() }),
    "utf8",
  );

  const lookedUp: string[] = [];
  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => [{ directory: target, strategy: "cow" }],
      create: async () => {
        throw new Error("attach must never request a create");
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
    session: {
      create: async () => ({ id: "ses_new" }),
      // The augmented structural slice the live binding adapts: the runtime
      // takes `{ sessionID }`, the tool's seam takes a bare id.
      get: async ({ sessionID }: { sessionID: string }) => {
        lookedUp.push(sessionID);
        return { id: sessionID, time: { updated: Date.now() } };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  const tool = registered.find((entry) => entry.name === "spawn_workspace");
  expect(tool).toBeDefined();

  await expect(tool!.execute({ sourceDirectory: dir, name: "occ" })).rejects.toThrow(
    /refusing to attach.*session ses_marked.*Pick another worktree name/s,
  );
  expect(lookedUp).toEqual(["ses_marked"]);
});

test("a marker-write failure surfaces as markerWarning on the registered tool", async () => {
  // `.git/info` as a file blocks the exclude write, so writeMarker fails; the
  // attach must still succeed and carry the failure as a warning.
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{
      output: { attached?: boolean; markerWarning?: string };
      content: string;
    }>;
  }> = [];
  const dir = await mkdtemp(join(tmpdir(), "cow-tool-warn-"));
  scratchDirs.push(dir);
  const target = join(dir, "..", "warn");
  scratchDirs.push(target);
  await mkdir(join(target, ".git"), { recursive: true });
  // A file where the exclude's directory must live: the marker write fails
  // with ENOTDIR — an obstacle no "treat every error as missing" fallback
  // could paper over — which is exactly the warning path.
  await writeFile(join(target, ".git", "info"), "not a directory", "utf8");

  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => [{ directory: target, strategy: "cow" }],
      create: async () => {
        throw new Error("attach must never request a create");
      },
      remove: async () => {},
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: {
            name: string;
            execute: (input: unknown) => Promise<{
              output: { attached?: boolean; markerWarning?: string };
              content: string;
            }>;
          }) => {
            registered.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: { create: async () => ({ id: "ses_new" }) },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  const tool = registered.find((entry) => entry.name === "spawn_workspace");
  expect(tool).toBeDefined();

  const result = await tool!.execute({ sourceDirectory: dir, name: "warn" });
  expect(result.output.attached).toBe(true);
  expect(result.output.markerWarning).toContain("could not be written");
  expect(result.content).toContain("warning: the occupancy marker could not be written");
});

// ---------------------------------------------------------------------------
// list_worktrees (ADR 0003)
//
// The listing is derived from the inventory alone: filter to cow, name from
// the basename, createdAt from one stat. An unreadable row fails the list.
// ---------------------------------------------------------------------------

/** Fakes the two seams `listCowWorktrees` reads and records what was stat'd. */
function fakeListDeps(
  inventory: ReadonlyArray<{ directory: string; strategy?: string }>,
  stamps: Readonly<Record<string, { birthtimeMs: number; mtimeMs: number }>> = {},
): { deps: ListWorktreesDeps; statted: string[] } {
  const statted: string[] = [];
  const deps: ListWorktreesDeps = {
    listWorktrees: async () => inventory,
    statEntry: async (path) => {
      statted.push(path);
      const stamp = stamps[path];
      if (stamp === undefined) throw new Error(`ENOENT: ${path}`);
      return stamp;
    },
  };
  return { deps, statted };
}

test("list on an empty inventory is an empty list, not an error", async () => {
  const { deps, statted } = fakeListDeps([]);
  expect(await listCowWorktrees(deps)).toEqual([]);
  expect(statted).toEqual([]);
});

test("list keeps only cow rows: the checkout root and git worktrees are dropped", async () => {
  const { deps, statted } = fakeListDeps(
    [
      { directory: "/repo" },
      { directory: "/wt/shallow", strategy: "git" },
      { directory: "/wt/worker", strategy: "cow" },
    ],
    { "/wt/worker": { birthtimeMs: 1_000, mtimeMs: 9_000 } },
  );
  expect(await listCowWorktrees(deps)).toEqual([
    {
      name: "worker",
      directory: "/wt/worker",
      strategy: "cow",
      createdAt: new Date(1_000).toISOString(),
    },
  ]);
  // Dropped rows are never stat'd: only survivors touch the filesystem.
  expect(statted).toEqual(["/wt/worker"]);
});

test("createdAt prefers birthtime when the filesystem reports one", async () => {
  const { deps } = fakeListDeps([{ directory: "/wt/worker", strategy: "cow" }], {
    "/wt/worker": { birthtimeMs: 500, mtimeMs: 9_000 },
  });
  const [entry] = await listCowWorktrees(deps);
  expect(entry!.createdAt).toBe(new Date(500).toISOString());
});

test("createdAt falls back to mtime when birthtime is zero/epoch (btrfs)", async () => {
  const { deps } = fakeListDeps([{ directory: "/wt/worker", strategy: "cow" }], {
    "/wt/worker": { birthtimeMs: 0, mtimeMs: 42 },
  });
  const [entry] = await listCowWorktrees(deps);
  expect(entry!.createdAt).toBe(new Date(42).toISOString());
});

test("an inventory-listed directory that cannot be stat'd fails the whole list loudly", async () => {
  // Fail-loud by design: the inventory is truth, so an unreadable row is a
  // real anomaly — skipping it would report an incomplete list as complete.
  const { deps } = fakeListDeps(
    [
      { directory: "/wt/ok", strategy: "cow" },
      { directory: "/wt/ghost", strategy: "cow" },
    ],
    { "/wt/ok": { birthtimeMs: 1, mtimeMs: 2 } },
  );
  await expect(listCowWorktrees(deps)).rejects.toThrow(/\/wt\/ghost/);
});

/** The slice of the registered ToolInfo the registration-shape assertions read. */
interface RegisteredToolShape {
  readonly name: string;
  readonly input?: { required?: string[] };
  readonly output?: {
    required?: string[];
    properties?: { worktrees?: { items?: { required?: string[] } } };
  };
  readonly options?: { readonly codemode?: boolean };
}

/** Runs plugin.setup against a fake ctx that records every registered tool. */
async function captureRegisteredTools(): Promise<Array<Record<string, unknown>>> {
  const registered: Array<Record<string, unknown>> = [];
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
          add: (tool: Record<string, unknown>) => registered.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];
  await plugin.setup(ctx);
  return registered;
}

test("list_worktrees is registered beside spawn_workspace, on the native tool list, with a declared output schema", async () => {
  const registered = await captureRegisteredTools();
  const list = registered.find((entry) => entry.name === "list_worktrees") as
    | RegisteredToolShape
    | undefined;
  expect(list).toBeDefined();
  // Same registration defects #9 found for spawn_workspace, asserted for the
  // second tool: native tool list, and a declared output schema.
  expect(list!.options?.codemode).toBe(false);
  expect(list!.output).toBeDefined();
  expect(list!.output!.required).toEqual(["worktrees"]);
  expect(list!.output!.properties?.worktrees?.items?.required).toEqual([
    "name",
    "directory",
    "strategy",
    "createdAt",
  ]);
  // The tool takes no input: the schema requires nothing.
  expect(list!.input!.required).toBeUndefined();
});

/** The list tool driven through its live ctx bindings, with a real stat. */
async function registeredListTool(
  listed: ReadonlyArray<{ directory: string; strategy?: string }>,
  options?: Record<string, unknown>,
): Promise<{
  output: { worktrees: Array<Record<string, unknown>> };
  content: string;
}> {
  const registered: Array<{
    name: string;
    execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
  }> = [];
  const ctx = {
    options,
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: async () => {} };
      },
      list: async () => listed,
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: {
            name: string;
            execute: (input: unknown) => Promise<{ output: unknown; content: string }>;
          }) => registered.push(tool),
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  const tool = registered.find((entry) => entry.name === "list_worktrees");
  expect(tool).toBeDefined();
  return (await tool!.execute({})) as {
    output: { worktrees: Array<Record<string, unknown>> };
    content: string;
  };
}

test("the registered list_worktrees tool reads the inventory and stats the real directory", async () => {
  // Any filesystem will do: the listing only stats the directory. A plain
  // tmpdir keeps this test independent of the CoW-root discovery.
  const dir = await mkdtemp(join(tmpdir(), "cow-list-"));
  scratchDirs.push(dir);

  const result = await registeredListTool([{ directory: dir, strategy: "cow" }]);
  const [entry] = result.output.worktrees;
  expect(entry).toEqual({
    name: basename(dir),
    directory: dir,
    strategy: "cow",
    createdAt: entry!.createdAt,
  });
  // The wiring decides nothing about birthtime vs mtime itself; it must
  // produce a real timestamp of that directory. The decision rule is pinned
  // by the injected-stamp tests above. Candidate strings, not raw ms: mtime
  // can carry sub-ms precision that toISOString rounds.
  const times = await stat(dir);
  expect([
    new Date(times.birthtimeMs).toISOString(),
    new Date(times.mtimeMs).toISOString(),
  ]).toContain(entry!.createdAt as string);
  // The one-line summary precedes the 2-space JSON rendering.
  expect(result.content.startsWith("1 cow worktree(s):\n")).toBe(true);
  expect(result.content).toContain(JSON.stringify(result.output.worktrees, null, 2));
});

test("the registered list_worktrees tool reports an empty list without an error", async () => {
  const result = await registeredListTool([]);
  expect(result.output).toEqual({ worktrees: [] });
  expect(result.content).toBe("0 cow worktree(s)\n[]");
});

// (The old "list_worktrees ignores clone options" pin is gone with the lazy
// validation it described: a misconfigured option now fails setup before any
// tool exists — pinned in test/plugin-fallback.test.ts.)

test("the registered list_worktrees tool fails loudly on an unreadable inventory row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cow-list-"));
  scratchDirs.push(dir);
  const missing = join(dir, "missing");

  await expect(registeredListTool([{ directory: missing, strategy: "cow" }])).rejects.toThrow(
    new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
