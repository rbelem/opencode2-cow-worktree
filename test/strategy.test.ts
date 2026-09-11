import { afterEach, expect, test } from "bun:test";
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
import { cowStrategy } from "../src/strategy";
import plugin from "../src/plugin";

// Scratch repositories live on the CoW filesystem under test. The machine's
// /home (and /) is btrfs, so /tmp/opencode reflinks.
const COW_ROOT = "/tmp/opencode";
// /dev/shm is tmpfs: a real filesystem without CoW support, available without
// root and without a loopback image. Used to prove the fail-loud branch.
const NON_COW_ROOT = "/dev/shm";

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

test("a worktree created through the registered strategy is a Deep clone", async () => {
  const added: Added[] = [];
  await plugin.setup(fakeContext(added));
  const { repo } = await makeScratchRepo(COW_ROOT);
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

test("removing a worktree through the strategy removes its directory", async () => {
  const { repo } = await makeScratchRepo(COW_ROOT);
  const target = join(repo, "..", "clone");
  const signal = new AbortController().signal;
  await cowStrategy.create({ sourceDirectory: repo, directory: target }, { signal });

  await cowStrategy.remove({ directory: target, force: true }, { signal });

  await expect(lstat(target)).rejects.toThrow();
});

test("list returns no entries, leaving inventory to opencode2", async () => {
  const signal = new AbortController().signal;
  expect(await cowStrategy.list("/anywhere", { signal })).toEqual([]);
});

test("create fails loudly on a filesystem without CoW support and leaves no directory", async () => {
  const { repo } = await makeScratchRepo(NON_COW_ROOT);
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

test("create rejects when the signal is already aborted", async () => {
  const { repo } = await makeScratchRepo(COW_ROOT);
  const target = join(repo, "..", "clone");
  const controller = new AbortController();
  controller.abort();

  await expect(
    cowStrategy.create({ sourceDirectory: repo, directory: target }, { signal: controller.signal }),
  ).rejects.toThrow();
  await expect(lstat(target)).rejects.toThrow();
});
