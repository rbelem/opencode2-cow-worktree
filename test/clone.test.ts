import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, link, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloneDirectory, reflinkFile } from "../src/clone";

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
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; stdout?: string };
    throw new Error(
      `git ${args.join(" ")} failed (${failure.status}): ${failure.stderr ?? failure.stdout ?? error}`,
    );
  }
}

interface ScratchRepo {
  dir: string;
  repo: string;
  clone: string;
}

/**
 * A real scratch git repository: tracked files, an ignored dependency
 * directory, an ignored file, relative symbolic links (to a file and to a
 * directory), a hard link, and an incompressible blob so shared extents are
 * measurable. `git` reports it clean.
 */
async function makeScratchRepo(root: string): Promise<ScratchRepo> {
  const dir = await mkdtemp(join(root, "cow-clone-"));
  scratchDirs.push(dir);
  const repo = join(dir, "source");
  const clone = join(dir, "clone");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  await writeFile(join(repo, "tracked.txt"), "tracked contents\n");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "app.ts"), "export const answer = 42;\n");
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(repo, "debug.log"), "ignored log line\n");
  await writeFile(join(repo, "blob.bin"), randomBytes(4 * 1024 * 1024));
  await symlink("tracked.txt", join(repo, "link-to-tracked"));
  await symlink("src", join(repo, "link-to-src"));
  await link(join(repo, "tracked.txt"), join(repo, "hardlink.txt"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "scratch");
  return { dir, repo, clone };
}

/** Every relative path in a tree, with `/` for directories and `@` for links. */
async function listTree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(root, entry.name);
    const stats = await lstat(abs);
    out.push(stats.isSymbolicLink() ? `${rel}@` : stats.isDirectory() ? `${rel}/` : rel);
    if (stats.isDirectory()) out.push(...(await listTree(abs, rel)));
  }
  return out.sort();
}

/** Identity of every entry, to prove a tree was not modified. */
async function snapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(root, entry.name);
    const stats = await lstat(abs);
    out[rel] = `${stats.mode}:${stats.size}:${stats.mtimeMs}:${stats.ino}`;
    if (stats.isDirectory()) Object.assign(out, await snapshot(abs, rel));
  }
  return out;
}

interface BtrfsUsage {
  total: number;
  exclusive: number;
  shared: number;
}

/**
 * `btrfs filesystem du` is the extent-level measurement: a file whose extents
 * are shared with the source reports those bytes as `shared`, while a real
 * copy reports none. GNU `du` reads `st_blocks`, which counts every file's
 * full allocation and cannot see sharing. (btrfs-progs v7.1 reports
 * single-reference extents as zero, so `shared` is the signal that distinguishes
 * a reflink clone from a byte copy.)
 */
function btrfsDu(path: string): BtrfsUsage {
  const output = execFileSync("btrfs", ["filesystem", "du", "-s", "--raw", path], {
    encoding: "utf8",
  });
  const numbers = (output.trim().split("\n")[1] ?? "").trim().split(/\s+/);
  return {
    total: Number(numbers[0] ?? 0),
    exclusive: Number(numbers[1] ?? 0),
    shared: Number(numbers[2] ?? 0),
  };
}

async function captureError(run: Promise<unknown>): Promise<{ code?: string } | undefined> {
  return run.then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );
}

test("clones the whole tree: tracked, ignored, directories, links and .git", async () => {
  const { repo, clone } = await makeScratchRepo(COW_ROOT);
  await cloneDirectory(repo, clone);

  expect(await readFile(join(clone, "tracked.txt"), "utf8")).toBe("tracked contents\n");
  expect(await readFile(join(clone, "src", "app.ts"), "utf8")).toBe("export const answer = 42;\n");
  // Ignored state carried over — the reason this feature exists.
  expect(await readFile(join(clone, "node_modules", "dep", "index.js"), "utf8")).toBe(
    "module.exports = 1;\n",
  );
  expect(await readFile(join(clone, "debug.log"), "utf8")).toBe("ignored log line\n");
  // A hard link is cloned as a regular file.
  expect((await lstat(join(clone, "hardlink.txt"))).isFile()).toBe(true);
  expect(await readFile(join(clone, "hardlink.txt"), "utf8")).toBe("tracked contents\n");

  // The clone reproduces the source's exact structure, metadata directory included.
  const cloneTree = await listTree(clone);
  expect(cloneTree).toEqual(await listTree(repo));
  expect(cloneTree).toContain(".git/HEAD");
});

test("recreates symbolic links as links, never following them", async () => {
  const { repo, clone } = await makeScratchRepo(COW_ROOT);
  await cloneDirectory(repo, clone);

  const fileLink = join(clone, "link-to-tracked");
  expect((await lstat(fileLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(fileLink)).toBe("tracked.txt");
  expect(await readFile(fileLink, "utf8")).toBe("tracked contents\n");

  const dirLink = join(clone, "link-to-src");
  expect((await lstat(dirLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(dirLink)).toBe("src");
});

test("contains a standalone .git and reports the same git state as the source", async () => {
  const { repo, clone } = await makeScratchRepo(COW_ROOT);
  await cloneDirectory(repo, clone);

  expect((await lstat(join(clone, ".git"))).isDirectory()).toBe(true);
  // No alternates: the clone does not point at the source's object store.
  await expect(readFile(join(clone, ".git", "objects", "info", "alternates"), "utf8")).rejects.toThrow();

  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(clone, "status", "--porcelain")).toBe(git(repo, "status", "--porcelain"));
  expect(git(clone, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));

  // Prove independence: with the source moved away, the clone still works.
  await rename(repo, `${repo}.moved`);
  expect(git(clone, "status", "--porcelain")).toBe("");
  expect(git(clone, "cat-file", "-p", "HEAD").length).toBeGreaterThan(0);
});

test("editing tracked and ignored files in the clone leaves the source byte-for-byte unchanged", async () => {
  const { repo, clone } = await makeScratchRepo(COW_ROOT);
  const sourceTracked = join(repo, "tracked.txt");
  const sourceIgnored = join(repo, "node_modules", "dep", "index.js");
  const beforeTracked = await readFile(sourceTracked);
  const beforeIgnored = await readFile(sourceIgnored);

  await cloneDirectory(repo, clone);
  await writeFile(join(clone, "tracked.txt"), "changed in clone\n");
  await writeFile(join(clone, "node_modules", "dep", "index.js"), "changed dependency\n");

  expect(await readFile(join(clone, "tracked.txt"), "utf8")).toBe("changed in clone\n");
  expect(await readFile(join(clone, "node_modules", "dep", "index.js"), "utf8")).toBe(
    "changed dependency\n",
  );
  expect(await readFile(sourceTracked)).toEqual(beforeTracked);
  expect(await readFile(sourceIgnored)).toEqual(beforeIgnored);
});

test("cloning does not modify the source directory", async () => {
  const { repo, clone } = await makeScratchRepo(COW_ROOT);
  const before = await snapshot(repo);

  await cloneDirectory(repo, clone);

  expect(await snapshot(repo)).toEqual(before);
});

test("shares file extents with the source instead of copying them", async () => {
  const { dir, repo, clone } = await makeScratchRepo(COW_ROOT);
  await cloneDirectory(repo, clone);

  // Control: the same bytes as a real byte copy, with reflinking disabled.
  const copy = join(dir, "real-copy");
  execFileSync("cp", ["-a", "--reflink=never", repo, copy]);
  expect((await stat(join(copy, "blob.bin"))).size).toBe(4 * 1024 * 1024);

  const cloned = btrfsDu(clone);
  const copied = btrfsDu(copy);

  // The clone's extents are shared with the source and almost none are
  // exclusive to it; a real copy of the same bytes shares nothing.
  expect(cloned.total).toBeGreaterThan(1_000_000);
  expect(cloned.shared).toBeGreaterThan(1_000_000);
  expect(cloned.exclusive).toBeLessThan(cloned.total / 4);
  expect(copied.shared).toBe(0);
});

test("fails explicitly on a filesystem without CoW support", async () => {
  const { dir, repo, clone } = await makeScratchRepo(NON_COW_ROOT);
  // Sanity: prove this filesystem really rejects a forced reflink.
  const probe = await captureError(reflinkFile(join(repo, "tracked.txt"), join(dir, "probe")));
  expect(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]).toContain(probe?.code ?? "");

  const error = await captureError(cloneDirectory(repo, clone));
  expect(error).toBeDefined();
  expect(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]).toContain(error?.code ?? "");
  // Fail loud, not silently: the blob was never materialized as a full copy.
  await expect(readFile(join(clone, "blob.bin"))).rejects.toThrow();
});
