import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cowStrategy, probeUncommitted } from "../src/strategy";
import * as strategyModule from "../src/strategy";
import plugin from "../src/plugin";
import { findCowRoot, findNonCowRoot, hasGit } from "./fs-roots";

// Discover the roots instead of hardcoding this machine's mounts. The CoW
// tests skip cleanly where no CoW filesystem exists; the negative test needs a
// filesystem that definitively refuses a clone. Tests that build a scratch git
// repository also skip when git is absent.
const cowRoot = await findCowRoot();
const nonCowRoot = await findNonCowRoot();
const gitOnPath = hasGit();

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface Scratch {
  dir: string;
  repo: string;
}

/**
 * A real scratch git repository with tracked files, an ignored dependency
 * directory, an ignored file, a symbolic link, and an incompressible blob.
 */
async function makeScratchRepo(root: string): Promise<Scratch> {
  const dir = await mkdtemp(join(root, "cow-strategy-"));
  scratchDirs.push(dir);
  const repo = join(dir, "source");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  await writeFile(join(repo, "tracked.txt"), "tracked contents\n");
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(repo, "debug.log"), "ignored log line\n");
  await writeFile(join(repo, "blob.bin"), randomBytes(8 * 1024 * 1024));
  await symlink("tracked.txt", join(repo, "link-to-tracked"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "scratch");
  return { dir, repo };
}

interface Added {
  readonly id: string;
  readonly definition: typeof cowStrategy;
}

/** A fake Context that records what the plugin registers through the seam. */
function fakeContext(added: Added[]) {
  const editor = {
    add: (definition: typeof cowStrategy) => {
      added.push({ id: definition.id, definition });
    },
  };
  const ctx = {
    worktree: {
      transform: async (callback: (editor: unknown) => void) => {
        callback(editor);
        return { dispose: async () => {} };
      },
    },
  };
  return ctx as unknown as Parameters<typeof plugin.setup>[0];
}

test("plugin setup registers exactly one strategy, with id cow", async () => {
  const added: Added[] = [];
  await plugin.setup(fakeContext(added));

  expect(plugin.id).toBe("opencode2-cow-worktree");
  expect(added).toHaveLength(1);
  expect(added[0]?.id).toBe("cow");
  expect(added[0]?.definition).toBe(cowStrategy);
});

test.skipIf(cowRoot === undefined || !gitOnPath)("a worktree created through the registered strategy is a Deep clone", async () => {
  const added: Added[] = [];
  await plugin.setup(fakeContext(added));
  const { repo } = await makeScratchRepo(cowRoot!);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;

  // Drive the strategy the plugin actually registered, not the module import.
  const definition = added[0]!.definition;
  const created = await definition.create(
    { sourceDirectory: repo, directory: target },
    { signal },
  );

  expect(created).toEqual({ directory: target });
  // Ignored state is why this Strategy exists.
  expect(await readFile(join(target, "node_modules", "dep", "index.js"), "utf8")).toBe(
    "module.exports = 1;\n",
  );
  expect(await readFile(join(target, "debug.log"), "utf8")).toBe("ignored log line\n");
  // A link is a link, not a copy of its target.
  expect((await lstat(join(target, "link-to-tracked"))).isSymbolicLink()).toBe(true);
  // A real, standalone metadata directory with no dependency on the source.
  expect((await lstat(join(target, ".git"))).isDirectory()).toBe(true);
  await expect(
    readFile(join(target, ".git", "objects", "info", "alternates"), "utf8"),
  ).rejects.toThrow();
  expect(git(target, "status", "--porcelain")).toBe(git(repo, "status", "--porcelain"));

  // Editing in the clone leaves the source byte-for-byte unchanged.
  const beforeTracked = await readFile(join(repo, "tracked.txt"));
  const beforeIgnored = await readFile(join(repo, "node_modules", "dep", "index.js"));
  await writeFile(join(target, "tracked.txt"), "changed in clone\n");
  await writeFile(join(target, "node_modules", "dep", "index.js"), "changed dependency\n");
  expect(await readFile(join(repo, "tracked.txt"))).toEqual(beforeTracked);
  expect(await readFile(join(repo, "node_modules", "dep", "index.js"))).toEqual(beforeIgnored);

  // The clone is genuinely independent: it still reads git with the source gone.
  await rename(repo, `${repo}.moved`);
  expect(git(target, "status", "--porcelain")).toBe(" M tracked.txt\n");
});

test.skipIf(cowRoot === undefined || !gitOnPath)("removing a worktree through the strategy removes its directory", async () => {
  const { repo } = await makeScratchRepo(cowRoot!);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;
  await cowStrategy.create({ sourceDirectory: repo, directory: target }, { signal });

  await cowStrategy.remove({ directory: target, force: true }, { signal });

  await expect(lstat(target)).rejects.toThrow();
});

// Not gated on a CoW filesystem: `remove` never reflinks, so this runs in CI
// where no CoW root exists. It is the strategy-level half of issue #12 — the
// `DELETE /api/worktree` half lives in `scripts/e2e/scenarios.ts`, because the
// server refuses before it reaches this code.
test("remove is idempotent: a missing directory is not an error at force", async () => {
  const signal = new AbortController().signal;
  const gone = join(tmpdir(), `cow-remove-gone-${randomBytes(8).toString("hex")}`);

  await expect(cowStrategy.remove({ directory: gone, force: true }, { signal })).resolves.toBeUndefined();
});

test("remove still fails loudly on a real error, not just a missing path", async () => {
  const signal = new AbortController().signal;
  // A file where a path component is expected is corruption, not absence, and
  // must not be swallowed along with ENOENT.
  const parent = await mkdtemp(join(tmpdir(), "cow-remove-enotdir-"));
  scratchDirs.push(parent);
  await writeFile(join(parent, "a-file"), "not a directory\n");

  await expect(
    cowStrategy.remove({ directory: join(parent, "a-file", "child"), force: true }, { signal }),
  ).rejects.toThrow();
});

// --- the uncommitted-work guard (issue #13) ---
//
// `remove` at `force: false` must refuse a worktree whose git status is not
// positively clean, and must do so before touching the filesystem. The
// injected `probeUncommitted` seam keeps each branch deterministic: a real
// git repository for the two end-to-end survival cases, and a stub for the
// branches a real repository cannot produce (unknown, probe failure).

/** A directory holding one real file; returns the file path for survival checks. */
async function makePlainDir(prefix: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const file = join(dir, "precious.txt");
  await writeFile(file, "uncommitted work\n");
  return { dir, file };
}

test("remove at force: false deletes a clean worktree", async () => {
  // The probe must positively report "clean" to allow a delete, so this uses a
  // real repository with no changes, not a directory without git metadata
  // (which is unknown and deliberately refuses).
  test.skipIf(!gitOnPath);
  const signal = new AbortController().signal;
  const dir = await mkdtemp(join(tmpdir(), "cow-remove-clean-"));
  scratchDirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scratch");

  expect(await probeUncommitted(dir)).toEqual([]);
  await expect(
    cowStrategy.remove({ directory: dir, force: false }, { signal }),
  ).resolves.toBeUndefined();
  await expect(lstat(dir)).rejects.toThrow();
});

test("remove at force: true deletes without probing", async () => {
  const signal = new AbortController().signal;
  const { dir } = await makePlainDir("cow-remove-forced-");
  let probed = 0;
  const spy = spyOn(strategyModule, "probeUncommitted").mockImplementation(async () => {
    probed += 1;
    return ["precious.txt"];
  });
  try {
    // The force is authorization, not a request to ask again: even a probe
    // that would answer "dirty" must not run, and the delete must succeed.
    await expect(
      cowStrategy.remove({ directory: dir, force: true }, { signal }),
    ).resolves.toBeUndefined();
    expect(probed).toBe(0);
    await expect(lstat(dir)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});

test("remove at force: false refuses a dirty worktree and every file survives", async () => {
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-dirty-");
  const spy = spyOn(strategyModule, "probeUncommitted").mockImplementation(async () => [
    "precious.txt",
    "src/app.ts",
  ]);
  try {
    const error = await cowStrategy
      .remove({ directory: dir, force: false }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      `cow refuses to remove ${dir} without force: ` +
        "2 uncommitted change(s) (e.g. precious.txt, src/app.ts). " +
        "Re-run with force to delete them.",
    );
    // The whole point: nothing was touched. The directory and its file are
    // still there, byte for byte.
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
    expect((await lstat(dir)).isDirectory()).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("remove at force: false refuses when the probe cannot answer", async () => {
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-unknown-");
  const spy = spyOn(strategyModule, "probeUncommitted").mockImplementation(
    async () => undefined,
  );
  try {
    const error = await cowStrategy
      .remove({ directory: dir, force: false }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`cow refuses to remove ${dir} without force:`);
    expect(error?.message).toContain("could not be determined");
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
  } finally {
    spy.mockRestore();
  }
});

test("remove at force: false refuses a directory with no git metadata", async () => {
  // Not a stub: the real probe must report unknown for a plain directory, and
  // that unknown must refuse rather than delete.
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-nogit-");
  expect(await probeUncommitted(dir)).toBeUndefined();

  const error = await cowStrategy
    .remove({ directory: dir, force: false }, { signal })
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeInstanceOf(Error);
  expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
});

test("remove at force: false refuses when git itself fails", async () => {
  // `.git` exists but is not a git directory, so `git -C … status` exits
  // non-zero. That is a failed probe — unknown — and must refuse, not delete.
  test.skipIf(!gitOnPath);
  const signal = new AbortController().signal;
  const { dir, file } = await makePlainDir("cow-remove-badgit-");
  await writeFile(join(dir, ".git"), "not a git directory\n");
  expect(await probeUncommitted(dir)).toBeUndefined();

  const error = await cowStrategy
    .remove({ directory: dir, force: false }, { signal })
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toContain("could not be determined");
  expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
});

test("remove at force: true deletes a real dirty worktree", async () => {
  // End to end through the real probe: a real git worktree with a modified
  // tracked file is refused at force: false and deleted at force: true.
  test.skipIf(!gitOnPath);
  const signal = new AbortController().signal;
  const dir = await mkdtemp(join(tmpdir(), "cow-remove-real-dirty-"));
  scratchDirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scratch");
  await writeFile(join(dir, "tracked.txt"), "uncommitted\n");

  expect(await probeUncommitted(dir)).toEqual(["tracked.txt"]);
  await expect(
    cowStrategy.remove({ directory: dir, force: false }, { signal }),
  ).rejects.toThrow(/cow refuses to remove/);
  expect(await readFile(join(dir, "tracked.txt"), "utf8")).toBe("uncommitted\n");

  await cowStrategy.remove({ directory: dir, force: true }, { signal });
  await expect(lstat(dir)).rejects.toThrow();
});


test("list returns no entries, leaving inventory to opencode2", async () => {
  const signal = new AbortController().signal;
  expect(await cowStrategy.list("/anywhere", { signal })).toEqual([]);
});

test.skipIf(nonCowRoot === undefined || !gitOnPath)("create fails loudly on a filesystem without CoW support and leaves no directory", async () => {
  const { repo } = await makeScratchRepo(nonCowRoot!);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;

  const error = await cowStrategy
    .create({ sourceDirectory: repo, directory: target }, { signal })
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeDefined();
  expect(error?.message).toContain(target);
  // cloneDirectory creates the target before it can fail; the strategy must
  // clean that partial tree up rather than leave a directory behind.
  await expect(lstat(target)).rejects.toThrow();
});

test.skipIf(cowRoot === undefined || !gitOnPath)("create rejects when the signal is already aborted", async () => {
  const { repo } = await makeScratchRepo(cowRoot!);
  const target = join(repo, "..", "clone");
  const controller = new AbortController();
  controller.abort();

  await expect(
    cowStrategy.create({ sourceDirectory: repo, directory: target }, { signal: controller.signal }),
  ).rejects.toThrow();
  await expect(lstat(target)).rejects.toThrow();
});

// The strategy pre-flights the same cross-device rule the tool applies, so a
// target on another filesystem fails with a message naming the cause and the
// remedy instead of a bare EXDEV mid-walk. The target parent is a real
// directory (so the nearest-existing walk lands on it) whose device the seam
// reports as a different number, so no second mount is required.
test("create rejects a cross-device target before cloning anything", async () => {
  const { repo } = await makeScratchRepo("/tmp");
  const otherDevice = await mkdtemp("/tmp/cow-other-device-");
  scratchDirs.push(otherDevice);
  const target = join(otherDevice, "clone");
  const signal = new AbortController().signal;
  const realDeviceOf = await import("../src/tool").then((m) => m.deviceOf);
  const sourceDevice = await realDeviceOf(repo);
  const otherDeviceNumber = (sourceDevice ?? 0) + 1;
  // Report the target parent on a different device than the real source; all
  // other paths keep their real device.
  const probeDevice = async (path: string) =>
    path === otherDevice ? otherDeviceNumber : realDeviceOf(path);

  const spy = spyOn(await import("../src/tool"), "deviceOf").mockImplementation(probeDevice);
  try {
    const error = await cowStrategy
      .create({ sourceDirectory: repo, directory: target }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeDefined();
    expect(error?.message).toContain(`cow cannot clone ${repo} into ${otherDevice}`);
    expect(error?.message).toContain("different filesystem");
    expect(error?.message).toContain("worktree.directory");
    expect(error?.message).toContain("targetRoot");
    // Exit before the walk: cloneDirectory would have created the target.
    await expect(lstat(target)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});

test("create proceeds when source and target share a device", async () => {
  // A real scratch tree under a CoW root (when one exists) so the clone itself
  // runs; the device seam reports both sides the same. Without a CoW root the
  // clone fails for an unrelated reason, but the pre-flight must not be it.
  const { repo } = await makeScratchRepo(cowRoot ?? "/tmp");
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;
  const realDeviceOf = await import("../src/tool").then((m) => m.deviceOf);
  const sourceDevice = await realDeviceOf(repo);
  const probeDevice = async (path: string) => {
    const device = await realDeviceOf(path);
    // Report the target parent as the source's device: same-device, no reject.
    return path === join(repo, "..") ? sourceDevice : device;
  };

  const spy = spyOn(await import("../src/tool"), "deviceOf").mockImplementation(probeDevice);
  try {
    // Same devices: the pre-flight never rejects, so on a CoW root the clone
    // runs to completion. Off a CoW root the clone's own wrapper is the only
    // acceptable failure — never the cross-device message.
    const error = await cowStrategy
      .create({ sourceDirectory: repo, directory: target }, { signal })
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error?.message ?? "").not.toContain("different filesystem");
    if (error !== undefined) {
      expect(error.message).toContain("cow strategy failed to clone into");
    }
  } finally {
    spy.mockRestore();
  }
});

test("create proceeds when a device is unreadable, leaving the failure to the clone", async () => {
  // `deviceOf` returns undefined for a path it cannot read; that is "unknown",
  // not a mismatch, so the pre-flight must not fabricate a cross-device error
  // and the real clone attempt decides the outcome.
  const signal = new AbortController().signal;

  const error = await cowStrategy
    .create(
      { sourceDirectory: "/nowhere/source", directory: "/nowhere/clone" },
      { signal },
    )
    .then(() => undefined, (failure: unknown) => failure as Error);

  expect(error).toBeDefined();
  expect(error?.message).not.toContain("different filesystem");
  // It fails as the strategy's clone wrapper, not as a device rejection.
  expect(error?.message).toContain("cow strategy failed to clone into");
});
