import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeUncommitted } from "../src/uncommitted";
import { hasGit } from "./fs-roots";

// The git probe's own answers, pinned where the code lives (src/uncommitted.ts).
// The `remove` decisions these answers feed are pinned in
// test/strategy.test.ts; this file establishes what the probe reports before
// that decision consumes it.

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

/** A real scratch repository with one committed file; returns dir and file path. */
async function makeScratchRepo(prefix: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const file = join(dir, "tracked.txt");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(file, "committed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "scratch");
  return { dir, file };
}

test("a clean repository reports no uncommitted changes", async () => {
  // A positive "clean" — not the unknown of a missing probe — is what allows
  // `remove` at force: false to delete.
  test.skipIf(!gitOnPath);
  const { dir } = await makeScratchRepo("cow-probe-clean-");

  expect(await probeUncommitted(dir)).toEqual([]);
});

test("a modified tracked file is reported by path", async () => {
  test.skipIf(!gitOnPath);
  const { dir } = await makeScratchRepo("cow-probe-dirty-");
  await writeFile(join(dir, "tracked.txt"), "uncommitted\n");

  expect(await probeUncommitted(dir)).toEqual(["tracked.txt"]);
});

test("a directory without git metadata is unknowable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cow-probe-nogit-"));
  scratchDirs.push(dir);

  expect(await probeUncommitted(dir)).toBeUndefined();
});

test("a .git that is not a repository makes the probe report unknown", async () => {
  // `.git` exists but is not a git directory, so `git -C … status` exits
  // non-zero. Any error, non-zero exit, or timeout is unknown.
  test.skipIf(!gitOnPath);
  const dir = await mkdtemp(join(tmpdir(), "cow-probe-badgit-"));
  scratchDirs.push(dir);
  await writeFile(join(dir, ".git"), "not a git directory\n");

  expect(await probeUncommitted(dir)).toBeUndefined();
});
