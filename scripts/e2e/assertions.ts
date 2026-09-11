// SPDX-License-Identifier: MIT
/** Assertions the harness runs against a real server run. Each returns a line. */
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export class Assertions {
  readonly checks: Check[] = [];

  check(name: string, ok: boolean, detail = ""): void {
    this.checks.push({ name, ok, detail });
    if (!ok) throw new Error(`assertion failed: ${name}${detail ? ` (${detail})` : ""}`);
  }

  get failed(): readonly Check[] {
    return this.checks.filter((check) => !check.ok);
  }
}

/** A Deep clone carries ignored state, keeps links as links, and has a real `.git`. */
export async function assertDeepClone(
  assertions: Assertions,
  worktree: string,
  label: string,
): Promise<void> {
  const ignored = await readFile(join(worktree, "node_modules", "dep", "index.js"), "utf8").catch(() => undefined);
  assertions.check(`${label}: ignored dependency file is present`, ignored === "module.exports = 1;\n", String(ignored));

  const ignoredLog = await readFile(join(worktree, "debug.log"), "utf8").catch(() => undefined);
  assertions.check(`${label}: ignored file is present`, ignoredLog === "ignored log line\n", String(ignoredLog));

  const link = await lstat(join(worktree, "link-to-tracked"));
  assertions.check(`${label}: symlink is a link, not a copy`, link.isSymbolicLink());

  const dotGit = await lstat(join(worktree, ".git"));
  assertions.check(`${label}: .git is a real directory`, dotGit.isDirectory());

  const alternates = await readFile(join(worktree, ".git", "objects", "info", "alternates"), "utf8").catch(
    () => undefined,
  );
  assertions.check(`${label}: .git has no alternates (independent object store)`, alternates === undefined);

  const hardlink = await lstat(join(worktree, "hardlink.txt"));
  assertions.check(`${label}: hard link was carried as a regular file`, hardlink.isFile());
}

/** `git status --porcelain` must agree between the source and a worktree. */
export function assertGitState(assertions: Assertions, worktree: string, source: string, label: string): void {
  const status = (repo: string) => execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
  assertions.check(
    `${label}: git status matches the source`,
    status(worktree) === status(source),
    JSON.stringify(status(worktree)),
  );
}

/**
 * Extent sharing, measured with `btrfs filesystem du -s --raw`. On btrfs-progs
 * v7.1 a single-reference extent reports zero; a reflinked one reports the
 * bytes as `shared`. A `cp --reflink=never` control proves the measurement
 * distinguishes a clone from a copy.
 */
export function btrfsDu(path: string): { total: number; exclusive: number; shared: number } {
  const output = execFileSync("btrfs", ["filesystem", "du", "-s", "--raw", path], { encoding: "utf8" });
  const numbers = (output.trim().split("\n")[1] ?? "").trim().split(/\s+/);
  return { total: Number(numbers[0] ?? 0), exclusive: Number(numbers[1] ?? 0), shared: Number(numbers[2] ?? 0) };
}

export function assertSharedExtents(
  assertions: Assertions,
  worktree: string,
  control: string,
  label: string,
): { clone: ReturnType<typeof btrfsDu>; copy: ReturnType<typeof btrfsDu> } {
  const clone = btrfsDu(worktree);
  const copy = btrfsDu(control);
  assertions.check(`${label}: clone shares extents (shared > 1MiB)`, clone.shared > 1_048_576, JSON.stringify(clone));
  assertions.check(
    `${label}: clone's exclusive extents are a fraction of total`,
    clone.exclusive < clone.total / 4,
    JSON.stringify(clone),
  );
  assertions.check(`${label}: byte-copy control shares nothing`, copy.shared === 0, JSON.stringify(copy));
  return { clone, copy };
}
