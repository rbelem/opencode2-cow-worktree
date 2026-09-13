import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, link, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDirectory, reflinkFile } from "../src/clone";
import { findCowRoot, findNonCowRoot, hasGit } from "./fs-roots";

// Discover the roots instead of hardcoding this machine's mounts: the CoW
// tests skip cleanly where no CoW filesystem exists, and the negative test
// runs wherever a definitively non-CoW filesystem is found. Every test here
// builds a scratch git repository, so a machine without git also skips.
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
    // Same race as `snapshot`: a transient `.git` lock file can vanish between
    // the `readdir` and the `lstat`. Skip it rather than fail the walk.
    const stats = await lstat(abs).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) continue;
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
    // git runs background maintenance in a freshly-initialized repo and briefly
    // creates `.git/objects/maintenance.lock`. A file that appears or vanishes
    // between the `readdir` and the `lstat` is not a modification of the tree,
    // so an ENOENT here is skipped rather than thrown. Comparing two snapshots
    // of the same tree still holds: a file present in both walks is compared.
    const stats = await lstat(abs).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) continue;
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

/**
 * `btrfs filesystem du` needs the btrfs-progs binary on PATH against a btrfs
 * root; a CoW filesystem can be CoW without being btrfs. Detect both so the
 * extent-sharing test skips rather than fails on such a machine.
 */
function btrfsDuAvailable(root: string): boolean {
  try {
    btrfsDu(root);
    return true;
  } catch {
    return false;
  }
}

const canMeasureBtrfsExtents =
  cowRoot !== undefined && btrfsDuAvailable(cowRoot);

async function captureError(run: Promise<unknown>): Promise<{ code?: string } | undefined> {
  return run.then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );
}

test.skipIf(cowRoot === undefined || !gitOnPath)("clones the whole tree: tracked, ignored, directories, links and .git", async () => {
  const { repo, clone } = await makeScratchRepo(cowRoot!);
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

test.skipIf(cowRoot === undefined || !gitOnPath)("recreates symbolic links as links, never following them", async () => {
  const { repo, clone } = await makeScratchRepo(cowRoot!);
  await cloneDirectory(repo, clone);

  const fileLink = join(clone, "link-to-tracked");
  expect((await lstat(fileLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(fileLink)).toBe("tracked.txt");
  expect(await readFile(fileLink, "utf8")).toBe("tracked contents\n");

  const dirLink = join(clone, "link-to-src");
  expect((await lstat(dirLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(dirLink)).toBe("src");
});

test.skipIf(cowRoot === undefined || !gitOnPath)("contains a standalone .git and reports the same git state as the source", async () => {
  const { repo, clone } = await makeScratchRepo(cowRoot!);
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

test.skipIf(cowRoot === undefined || !gitOnPath)("editing tracked and ignored files in the clone leaves the source byte-for-byte unchanged", async () => {
  const { repo, clone } = await makeScratchRepo(cowRoot!);
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

test.skipIf(cowRoot === undefined || !gitOnPath)("cloning does not modify the source directory", async () => {
  const { repo, clone } = await makeScratchRepo(cowRoot!);
  const before = await snapshot(repo);

  await cloneDirectory(repo, clone);

  expect(await snapshot(repo)).toEqual(before);
});

test.skipIf(cowRoot === undefined || !git || !canMeasureBtrfsExtents)("shares file extents with the source instead of copying them", async () => {
  const { dir, repo, clone } = await makeScratchRepo(cowRoot!);
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

test.skipIf(nonCowRoot === undefined || !gitOnPath)("fails explicitly on a filesystem without CoW support", async () => {
  const { dir, repo, clone } = await makeScratchRepo(nonCowRoot!);
  // Sanity: prove this filesystem really rejects a forced reflink.
  const probe = await captureError(reflinkFile(join(repo, "tracked.txt"), join(dir, "probe")));
  expect(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]).toContain(probe?.code ?? "");

  const error = await captureError(cloneDirectory(repo, clone));
  expect(error).toBeDefined();
  expect(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]).toContain(error?.code ?? "");
  // Fail loud, not silently: the blob was never materialized as a full copy.
  await expect(readFile(join(clone, "blob.bin"))).rejects.toThrow();
});

test.skipIf(cowRoot === undefined || !gitOnPath)("clones into a subdirectory of the source without cloning the target into itself", async () => {
  const { repo } = await makeScratchRepo(cowRoot!);
  // The natural opencode2 shape: a relative `worktree.directory` resolved
  // against the project checkout, so the target lives inside the source. The
  // walk must skip it — descending would clone the clone into itself forever.
  const nested = join(repo, ".opencode", "worktrees", "one");
  await mkdir(join(repo, ".opencode", "keep"), { recursive: true });
  await writeFile(join(repo, ".opencode", "keep", "marker.txt"), "sibling of the target\n");

  await cloneDirectory(repo, nested);

  // The clone is a faithful copy of everything that is not the target.
  expect(await readFile(join(nested, "tracked.txt"), "utf8")).toBe("tracked contents\n");
  expect(await readFile(join(nested, "src", "app.ts"), "utf8")).toBe("export const answer = 42;\n");
  expect(await readFile(join(nested, "node_modules", "dep", "index.js"), "utf8")).toBe(
    "module.exports = 1;\n",
  );
  expect(await readFile(join(nested, "debug.log"), "utf8")).toBe("ignored log line\n");
  expect((await lstat(join(nested, ".git"))).isDirectory()).toBe(true);
  // The target's ancestors are ordinary directories: their other children are
  // cloned. Only the target subtree itself is skipped.
  expect(await readFile(join(nested, ".opencode", "keep", "marker.txt"), "utf8")).toBe(
    "sibling of the target\n",
  );

  // Nothing was copied into itself: no `one/one` nesting, and the skipped
  // directory does not appear in the clone.
  await expect(lstat(join(nested, ".opencode", "worktrees", "one"))).rejects.toThrow();
  expect(await listTree(nested)).not.toContain(".opencode/worktrees/one");

  // Termination plus the recursive reflink contract: a second walk into a fresh
  // sibling target (not inside the source) still succeeds unchanged.
  const sibling = join(repo, "..", "sibling-clone");
  await cloneDirectory(repo, sibling);
  expect(await readFile(join(sibling, "tracked.txt"), "utf8")).toBe("tracked contents\n");
});

test("rejects cloning a directory into itself", async () => {
  // The guard throws before any I/O — no CoW filesystem and no git are needed,
  // so this never skips. The directory only gives `resolve` a real absolute
  // path; it is removed by the same `afterEach` as every other scratch dir.
  const dir = await mkdtemp(join(tmpdir(), "cow-self-"));
  scratchDirs.push(dir);

  const error = await captureError(cloneDirectory(dir, dir));
  expect(error).toBeDefined();
  expect((error as Error).message).toMatch(/cannot clone .* into itself/);
});

test.skipIf(cowRoot === undefined || !gitOnPath)("rejects a target that contains the source", async () => {
  const { repo } = await makeScratchRepo(cowRoot!);
  // Cloning a subtree into an ancestor would write the clone over the very
  // tree being walked; that is not a shape the walk can satisfy, so it fails
  // fast and clearly instead of recursing.
  const error = await captureError(cloneDirectory(join(repo, "src"), repo));
  expect(error).toBeDefined();
  expect((error as Error).message).toMatch(/target contains the source/i);
  // Nothing was produced by the rejected call.
  await expect(lstat(join(repo, "src", "src"))).rejects.toThrow();
});

// --- the occupancy guard (ticket 08) ---
//
// `cow` never writes into, or deletes, bytes it did not create, so any
// pre-existing target is refused before the first filesystem write. That
// happens before the walker or the platform backend run, so these pins need
// no CoW filesystem and no git — they run anywhere, like the self-clone
// rejection above.

/** The refusal every occupied target must produce, naming the resolved path. */
async function expectOccupancyRefusal(run: Promise<unknown>): Promise<Error> {
  const error = await run.then(
    () => undefined,
    (failure: unknown) => failure as Error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toMatch(/cannot clone into .*: it already exists/);
  return error!;
}

test("refuses to clone into a pre-existing directory and leaves its content untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cow-occupied-"));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  const foreign = join(dir, "occupied");
  await mkdir(foreign);
  await writeFile(join(foreign, "theirs.txt"), "not ours\n");

  await expectOccupancyRefusal(cloneDirectory(source, foreign));

  // No merge happened: the directory holds exactly what it held before.
  expect(await readdir(foreign)).toEqual(["theirs.txt"]);
  expect(await readFile(join(foreign, "theirs.txt"), "utf8")).toBe("not ours\n");
});

test("refuses to clone into a pre-existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cow-occupied-file-"));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  const target = join(dir, "occupied");
  await writeFile(target, "a file, not a directory\n");

  await expectOccupancyRefusal(cloneDirectory(source, target));

  expect(await readFile(target, "utf8")).toBe("a file, not a directory\n");
});

test("refuses to clone into a pre-existing symlink without following it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cow-occupied-link-"));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  const pointee = join(dir, "pointee.txt");
  await writeFile(pointee, "the link's target\n");
  const target = join(dir, "occupied");
  await symlink(pointee, target);

  // `lstat` must see the link itself, not resolve through to the pointee —
  // otherwise the clone would write into whatever the link names.
  await expectOccupancyRefusal(cloneDirectory(source, target));

  expect((await lstat(target)).isSymbolicLink()).toBe(true);
  expect(await readlink(target)).toBe(pointee);
  expect(await readFile(pointee, "utf8")).toBe("the link's target\n");
});

test("a directory appearing between the caller's check and the clone survives the refusal untouched", async () => {
  // The race this pin exists for: a caller (the tool's attach check, the
  // strategy's caller) established that the predicted path was free, and a
  // foreign directory appeared before `cloneDirectory` ran. The old behavior
  // merged into it and left it to the caller's rollback `rm`; the guard must
  // refuse instead — no write, no merge, no cleanup — so the foreign
  // directory outlives the failed create byte for byte.
  const dir = await mkdtemp(join(tmpdir(), "cow-race-"));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  await writeFile(join(source, "tracked.txt"), "clone content\n");
  const target = join(dir, "predicted");

  // The caller's existence check: the path is free.
  await expect(lstat(target)).rejects.toThrow();
  // The interleaving: something else occupies the path before the clone.
  await mkdir(target);
  await writeFile(join(target, "appeared.txt"), "foreign\n");

  await expectOccupancyRefusal(cloneDirectory(source, target));

  // The refused create left no rollback behind: the directory and its bytes
  // are exactly as the race left them, and no clone content was merged in.
  expect(await readdir(target)).toEqual(["appeared.txt"]);
  expect(await readFile(join(target, "appeared.txt"), "utf8")).toBe("foreign\n");
  await expect(lstat(join(target, "tracked.txt"))).rejects.toThrow();
});

test("an unknowable target path fails closed instead of reading as absence", async () => {
  // An occupancy probe that errors without ENOENT — here a path component
  // that is a file — must surface as a failure, never be swallowed into
  // "the path is free": merging into a path no one could inspect is exactly
  // what the guard exists to prevent.
  const dir = await mkdtemp(join(tmpdir(), "cow-uninspectable-"));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  const blocker = join(dir, "a-file");
  await writeFile(blocker, "not a directory\n");
  const target = join(blocker, "child");

  const error = await cloneDirectory(source, target).then(
    () => undefined,
    (failure: unknown) => failure as NodeJS.ErrnoException,
  );

  expect(error).toBeDefined();
  expect(error?.code).toBe("ENOTDIR");
  expect(error?.message).not.toMatch(/already exists/);
  expect(await readFile(blocker, "utf8")).toBe("not a directory\n");
});
