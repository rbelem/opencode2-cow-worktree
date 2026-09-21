import { expect, test } from "bun:test";

import { removeWorktree } from "../src/remove-tool";
import type { GitRun, RemoveWorktreeDeps } from "../src/remove-tool";
import type { UncommittedChanges } from "../src/dirty";
import plugin from "../src/plugin";

// remove_worktree's decision-table pins, driven entirely through fake seams —
// no opencode2, no filesystem, no git. The git seam is a responder keyed by
// the four commands the landed-ness guard runs (`symbolic-ref`,
// `rev-parse --verify --quiet`, `merge-base --is-ancestor`,
// `rev-list --count`), so every test states its scenario as data.

const WT = "/wt/worker";

/** A one-row cow inventory naming the worktree every happy path removes. */
function cowInventory(): Array<{ directory: string; strategy?: string }> {
  return [{ directory: WT, strategy: "cow" }];
}

/** What the fake git seam answers, per command; unlisted commands answer "no". */
interface GitScript {
  /** `symbolic-ref`'s answer; absent means exit 1 (no origin/HEAD). */
  readonly symbolicRef?: { code: number; stdout: string };
  /** Refs `rev-parse --verify --quiet` confirms; all others exit 1. */
  readonly verifiedRefs?: readonly string[];
  /** `merge-base --is-ancestor`'s exit code; absent means "not landed". */
  readonly mergeBase?: number;
  /** `rev-list --count`'s answer; absent means exit 1 with no output. */
  readonly revList?: { code: number; stdout: string };
}

/** Builds the git seam from a script; records every call for the assertions. */
function gitResponder(script: GitScript): {
  run: (args: string[], cwd: string) => GitRun;
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = (args: string[], cwd: string): GitRun => {
    calls.push({ args, cwd });
    const [command] = args;
    if (command === "symbolic-ref") {
      return script.symbolicRef ?? { code: 1, stdout: "" };
    }
    if (command === "rev-parse") {
      const ref = args[args.length - 1]!;
      return (script.verifiedRefs ?? []).includes(ref)
        ? { code: 0, stdout: `${ref}\n` }
        : { code: 1, stdout: "" };
    }
    if (command === "merge-base") {
      return { code: script.mergeBase ?? 1, stdout: "" };
    }
    if (command === "rev-list") {
      return script.revList ?? { code: 1, stdout: "" };
    }
    throw new Error(`fake git seam received an unexpected command: ${String(command)}`);
  };
  return { run, calls };
}

/** The fake deps: every seam is a recording fake; nothing touches the world. */
function fakeDeps(
  options: {
    readonly inventory?: ReadonlyArray<{ directory: string; strategy?: string }>;
    /** Paths `directoryExists` answers true for; everything else is gone. */
    readonly present?: readonly string[];
    /** The git script; absent means every git answer is "no". */
    readonly git?: (args: string[], cwd: string) => GitRun;
    /** The dirty probe's answer; absent means "cannot tell" (`undefined`). */
    readonly uncommitted?: UncommittedChanges;
  } = {},
): {
  deps: RemoveWorktreeDeps;
  removed: Array<{ directory: string; force: boolean }>;
  gitCalls: Array<{ args: string[]; cwd: string }>;
} {
  const removed: Array<{ directory: string; force: boolean }> = [];
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  const deps: RemoveWorktreeDeps = {
    listWorktrees: async () => options.inventory ?? [],
    removeWorktree: async (directory, force) => {
      removed.push({ directory, force });
    },
    directoryExists: async (directory) => options.present?.includes(directory) ?? false,
    runGit: async (args, cwd) => {
      gitCalls.push({ args, cwd });
      return options.git?.(args, cwd) ?? { code: 1, stdout: "" };
    },
    probeUncommitted: async () => options.uncommitted,
  };
  return { deps, removed, gitCalls };
}

test("a landed worktree removes without force, dirty or not", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n" },
    verifiedRefs: ["origin/main"],
    mergeBase: 0,
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    // Landed decides: uncommitted files do not block a landed HEAD.
    uncommitted: [".env"],
  });

  const result = await removeWorktree({ directory: WT }, deps);

  expect(result).toEqual({ directory: WT, forced: false });
  expect(removed).toEqual([{ directory: WT, force: false }]);
});

test("the origin/HEAD landing ref is trimmed to origin/<branch> before use", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n" },
    verifiedRefs: ["origin/main"],
    mergeBase: 0,
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
  });

  await removeWorktree({ directory: WT }, deps);

  const verified = gitCalls
    .filter((call) => call.args[0] === "rev-parse")
    .map((call) => call.args.at(-1));
  // The symbolic-ref answer was trimmed before verification, and only the
  // trimmed ref was asked about.
  expect(verified).toEqual(["origin/main"]);
  expect(gitCalls.every((call) => call.cwd === WT)).toBe(true);
  expect(removed).toEqual([{ directory: WT, force: false }]);
});

test("an origin/HEAD ref that does not verify falls through to main, then master", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/gone\n" },
    verifiedRefs: ["master"],
    mergeBase: 0,
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
  });

  await removeWorktree({ directory: WT }, deps);

  const verified = gitCalls
    .filter((call) => call.args[0] === "rev-parse")
    .map((call) => call.args.at(-1));
  expect(verified).toEqual(["origin/gone", "main", "master"]);
  expect(removed).toHaveLength(1);
});

test("a clean worktree with no unique commits removes at force:false even when unlanded", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "0\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: [],
  });

  const result = await removeWorktree({ directory: WT }, deps);

  // Clean and free of unique commits is the one unlanded state that passes;
  // force stays false, so the strategy's own dirty probe still runs.
  expect(removed).toEqual([{ directory: WT, force: false }]);
  expect(result.forced).toBe(false);
});

test("an unlanded, dirty worktree refuses without force and names the counts", async () => {
  const git = gitResponder({
    symbolicRef: { code: 0, stdout: "refs/remotes/origin/main\n" },
    verifiedRefs: ["origin/main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "3\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: ["src/a.ts", "src/b.ts"],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /3 unique commit\(s\).*2 uncommitted file\(s\).*Re-run with force to remove anyway/s,
  );
  expect(removed).toEqual([]);
});

test("an undeterminable dirty state refuses even with no unique commits (fail closed)", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "0\n" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    // probeUncommitted's "cannot tell" answer: never read as clean.
    uncommitted: undefined,
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /unknown number of uncommitted file\(s\).*Re-run with force/s,
  );
  expect(removed).toEqual([]);
});

test("a failed unique-commit count refuses (fail closed)", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 1, stdout: "" },
  });
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: [],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /unknown number of unique commit\(s\).*Re-run with force/s,
  );
  expect(removed).toEqual([]);
});

test("an undetectable landing ref refuses without force", async () => {
  // No origin/HEAD, and neither main nor master verifies: landed-ness cannot
  // be judged, so the removal refuses even though the tree is clean.
  const { deps, removed } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    uncommitted: [],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /landing ref could not be determined.*Re-run with force to remove anyway/s,
  );
  expect(removed).toEqual([]);
});

test("force bypasses the guard entirely and is passed through verbatim", async () => {
  const git = gitResponder({
    verifiedRefs: ["main"],
    mergeBase: 1,
    revList: { code: 0, stdout: "4\n" },
  });
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [WT],
    git: git.run,
    uncommitted: ["dirty.txt"],
  });

  const result = await removeWorktree({ directory: WT, force: true }, deps);

  expect(result).toEqual({ directory: WT, forced: true });
  expect(removed).toEqual([{ directory: WT, force: true }]);
  // The guard never ran: no git command, no dirty probe answer consulted.
  expect(gitCalls).toEqual([]);
});

test("a dangling inventory row is refused before the guard, even at force:true", async () => {
  const { deps, removed, gitCalls } = fakeDeps({
    inventory: cowInventory(),
    present: [], // the directory is gone; the row is dangling
  });

  await expect(removeWorktree({ directory: WT, force: true }, deps)).rejects.toThrow(
    /dangling.*candidate 8.*Worktree directory unavailable.*force:true/s,
  );
  expect(removed).toEqual([]);
  // The guard never ran git in a directory that is not there.
  expect(gitCalls).toEqual([]);
});

test("a directory the inventory does not know is refused as a Foreign worktree", async () => {
  const { deps, removed } = fakeDeps({ inventory: cowInventory(), present: ["/wt/stranger"] });

  await expect(removeWorktree({ directory: "/wt/stranger" }, deps)).rejects.toThrow(
    /refusing to remove \/wt\/stranger.*Foreign worktree/,
  );
  expect(removed).toEqual([]);
});

test("an inventory row of another strategy is refused, mirroring the attach refusal", async () => {
  const { deps, removed } = fakeDeps({
    inventory: [{ directory: WT, strategy: "git" }],
    present: [WT],
  });

  await expect(removeWorktree({ directory: WT }, deps)).rejects.toThrow(
    /refusing to remove \/wt\/worker.*records it with "git", not "cow"/,
  );

  const strategyless = fakeDeps({ inventory: [{ directory: WT }], present: [WT] });
  await expect(removeWorktree({ directory: WT }, strategyless.deps)).rejects.toThrow(
    /records it with no strategy, not "cow"/,
  );
  expect(removed).toEqual([]);
});

test("an unknown name refuses and lists the known cow rows", async () => {
  const { deps, removed } = fakeDeps({
    inventory: [
      { directory: "/wt/alpha", strategy: "cow" },
      { directory: "/wt/beta", strategy: "cow" },
    ],
  });

  await expect(removeWorktree({ name: "zzz" }, deps)).rejects.toThrow(
    /no cow worktree named "zzz".*alpha.*beta.*list_worktrees/s,
  );
  expect(removed).toEqual([]);
});

test("an unknown name in an inventory with no cow rows says there are none", async () => {
  const { deps } = fakeDeps({ inventory: [{ directory: "/wt/root" }] });

  await expect(removeWorktree({ name: "zzz" }, deps)).rejects.toThrow(
    /no cow worktree named "zzz".*no cow worktrees/s,
  );
});

test("a name several cow rows share is ambiguous, naming the candidates", async () => {
  const { deps, removed } = fakeDeps({
    inventory: [
      { directory: "/wt/a/worker", strategy: "cow" },
      { directory: "/wt/b/worker", strategy: "cow" },
    ],
  });

  await expect(removeWorktree({ name: "worker" }, deps)).rejects.toThrow(
    /ambiguous.*\/wt\/a\/worker.*\/wt\/b\/worker.*full directory/s,
  );
  expect(removed).toEqual([]);
});

test("a non-cow row is invisible to a name lookup, not a foreign-strategy refusal", async () => {
  // The name selector filters cow rows first, so a git-strategy row under the
  // same basename is simply not a match — it refuses as unknown, listing no
  // cow rows, and never removes the foreign worktree.
  const { deps, removed } = fakeDeps({
    inventory: [{ directory: WT, strategy: "git" }],
    present: [WT],
  });

  await expect(removeWorktree({ name: "worker" }, deps)).rejects.toThrow(
    /no cow worktree named "worker".*no cow worktrees/s,
  );
  expect(removed).toEqual([]);
});

test("resolving by name removes the inventory-recorded directory at force:false", async () => {
  const git = gitResponder({ verifiedRefs: ["main"], mergeBase: 0 });
  const { deps, removed } = fakeDeps({
    inventory: [{ directory: "/wt/recorded/worker", strategy: "cow" }],
    present: ["/wt/recorded/worker"],
    git: git.run,
  });

  const result = await removeWorktree({ name: "worker" }, deps);

  expect(result).toEqual({ directory: "/wt/recorded/worker", forced: false });
  expect(removed).toEqual([{ directory: "/wt/recorded/worker", force: false }]);
});

test("exactly one of name and directory is required", async () => {
  const { deps } = fakeDeps({ inventory: cowInventory() });

  await expect(removeWorktree({}, deps)).rejects.toThrow(
    /exactly one of "name" or "directory".*neither was given/s,
  );
  await expect(removeWorktree({ name: "worker", directory: WT }, deps)).rejects.toThrow(
    /exactly one of "name" or "directory".*both were given/s,
  );
  // An empty string is not a selector — the same rule attach applies to name —
  // so `{ name: "" }` refuses as "neither given" rather than matching nothing.
  await expect(removeWorktree({ name: "" }, deps)).rejects.toThrow(/neither was given/);
});

// ---------------------------------------------------------------------------
// Registration pins: remove_worktree joins the native tool list with the same
// contract as the other two tools, and its declared output schema matches what
// execute returns (a returned `output` without a schema is a hard defect).
// ---------------------------------------------------------------------------

/** The location slice `liveDeps` and the registration read. */
const fakeLocation = {
  directory: "/src",
  project: { id: "prj_test", directory: "/src", canonical: "/src" },
};

test("plugin setup registers remove_worktree on the native tool list with its output schema", async () => {
  const registered: Array<{
    name: string;
    options?: { codemode?: boolean };
    input?: unknown;
    output?: unknown;
  }> = [];
  const ctx = {
    location: fakeLocation,
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

  const tool = registered.find((entry) => entry.name === "remove_worktree");
  expect(tool).toBeDefined();
  // Callable by name, like spawn_workspace and list_worktrees.
  expect(tool!.options?.codemode).toBe(false);
  const output = tool!.output as {
    properties: Record<string, unknown>;
    required: readonly string[];
    additionalProperties: boolean;
  };
  expect([...output.required]).toEqual(["directory"]);
  expect(Object.keys(output.properties)).toEqual(["directory"]);
  expect(output.additionalProperties).toBe(false);
  const input = tool!.input as { properties: Record<string, unknown>; required?: string[] };
  expect(Object.keys(input.properties).sort()).toEqual(["directory", "force", "name"]);
  // Exactly-one-of is validated in execute, so the schema requires neither.
  expect(input.required).toBeUndefined();
});
