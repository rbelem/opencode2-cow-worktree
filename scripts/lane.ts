#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * Lane helper: spawn CoW lane clones and absorb them back (issue 06).
 *
 * Lanes are independent full clones made with `cloneDirectory` — reflink Deep
 * clone, `.git` included — not linked worktrees. The verified mechanics behind
 * every step here are in `docs/research/lane-merge-mechanics.md`; the
 * conventions this tool encodes are in `docs/lane-workflow.md`.
 *
 *   bun scripts/lane.ts spawn <name> [--count N] [--dir <parent>]
 *   bun scripts/lane.ts absorb <name> [--dir <parent>] [--merge] [--into <ref>]
 *
 * The tool never deletes anything, never pushes, and never rewrites history.
 * Absorb without `--merge` is a dry run: pre-checks, fetch, scope diff — no
 * merge.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloneDirectory } from "../src/clone";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Lanes are siblings of the repo by default (e.g. ../cow-lane-<name>). */
const DEFAULT_PARENT = resolve(REPO_ROOT, "..");

const USAGE = `usage:
  bun scripts/lane.ts spawn <name> [--count N] [--dir <parent>]
  bun scripts/lane.ts absorb <name> [--dir <parent>] [--merge] [--into <ref>]

spawn  CoW-clone this repo into <parent>/cow-lane-<name> (suffixed -1..-N with
       --count), strip the inherited origin remote, create branch
       lane-<name> (-<i> with --count). Refuses existing targets.
absorb Run from the main repo checkout. Lock-free lane pre-checks, pinned tip,
       fetch as refs/heads remapped to lane-<name>/lane-<name>, scope diff.
       --merge performs the --no-ff merge; --into overrides the target branch
       (default: main, and the checkout must be on it).`;

class UsageError extends Error {}

interface Parsed {
  readonly verb: "spawn" | "absorb";
  readonly name: string;
  count?: number;
  dir?: string;
  merge: boolean;
  into?: string;
}

/** Run git in `dir`; return trimmed stdout, throw on a non-zero exit. */
function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/**
 * Read-only probe of a possibly-live lane. `--no-optional-locks` keeps the
 * probe from taking git's optional lock files, so it never blocks (and is
 * never blocked by) an agent working in the lane.
 */
function probe(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** Run git tolerating failure: exit status plus captured output. */
function attempt(dir: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trimEnd(), stderr: (r.stderr ?? "").trimEnd() };
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** Lane names become a directory basename and a branch name; keep them tame. */
function laneName(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) {
    throw new UsageError(`invalid lane name '${raw}': letters, digits, '.', '_', '-' only`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Parsed {
  const [verb, rawName, ...rest] = argv;
  if (verb !== "spawn" && verb !== "absorb") throw new UsageError("first argument must be 'spawn' or 'absorb'");
  if (!rawName) throw new UsageError("missing lane name");
  const parsed: Parsed = { verb, name: laneName(rawName), merge: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = (): string => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${flag}`);
      i += 1;
      return v;
    };
    if (flag === "--count") {
      if (verb !== "spawn") throw new UsageError("--count is a spawn option");
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--count must be an integer >= 1, got '${n}'`);
      parsed.count = n;
    } else if (flag === "--dir") {
      parsed.dir = value();
    } else if (flag === "--merge") {
      if (verb !== "absorb") throw new UsageError("--merge is an absorb option");
      parsed.merge = true;
    } else if (flag === "--into") {
      if (verb !== "absorb") throw new UsageError("--into is an absorb option");
      parsed.into = value();
    } else {
      throw new UsageError(`unknown argument '${flag}'`);
    }
  }
  return parsed;
}

/** The clone target and branch for one lane; `--count` suffixes -1..-N. */
function laneTargets(name: string, parent: string, count?: number): ReadonlyArray<{ dir: string; branch: string }> {
  if (count === undefined) {
    return [{ dir: join(parent, `cow-lane-${name}`), branch: `lane-${name}` }];
  }
  return Array.from({ length: count }, (_, i) => ({
    dir: join(parent, `cow-lane-${name}-${i + 1}`),
    branch: `lane-${name}-${i + 1}`,
  }));
}

/**
 * Strip the origin remote a clone inherited with its copied `.git`: that
 * remote is the live, credential-bearing GitHub remote, and leaving it in
 * every lane is an accidental-push surface. Structural fix beats instruction
 * (risk register, docs/research/lane-merge-mechanics.md).
 */
function detachFromOrigin(clone: string): void {
  const remotes = git(clone, ["remote"]).split("\n").filter((r) => r !== "");
  if (remotes.includes("origin")) git(clone, ["remote", "remove", "origin"]);
}

async function spawnLanes(args: Parsed): Promise<void> {
  const parent = args.dir ?? DEFAULT_PARENT;
  const targets = laneTargets(args.name, parent, args.count);
  for (const target of targets) {
    if (await pathExists(target.dir)) {
      throw new Error(`refusing to spawn: ${target.dir} already exists (this tool never deletes)`);
    }
  }
  for (const target of targets) {
    await cloneDirectory(REPO_ROOT, target.dir);
    detachFromOrigin(target.dir);
    git(target.dir, ["switch", "--create", target.branch]);
    console.log(`${target.dir}  (branch ${target.branch})`);
  }
}

/** Lock-free pre-checks on the lane; returns the pinned tip. */
function precheck(clone: string, branch: string): string {
  try {
    probe(clone, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    throw new Error(`lane branch '${branch}' not found in ${clone}`);
  }
  const status = probe(clone, ["status", "--porcelain"]);
  if (status !== "") {
    throw new Error(`lane has uncommitted work — uncommitted work never travels:\n${status}`);
  }
  const tip = probe(clone, ["rev-parse", branch]);
  console.log(`lane tip: ${tip}  (${branch} in ${clone})`);
  return tip;
}

/** The git toplevel of the directory absorb runs in (the main repo). */
function gitRoot(start: string): string {
  try {
    return git(start, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`${start} is not inside a git repository — run absorb from the main repo checkout`);
  }
}

function currentBranch(repo: string): string {
  try {
    return git(repo, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    throw new Error(`${repo} is in detached HEAD; check out the integration branch first`);
  }
}

/** Add the lane remote unless it already exists; a stale URL is an error. */
function addRemote(repo: string, remote: string, clone: string): void {
  const remotes = git(repo, ["remote"]).split("\n").filter((r) => r !== "");
  if (!remotes.includes(remote)) {
    git(repo, ["remote", "add", remote, clone]);
    return;
  }
  const url = git(repo, ["remote", "get-url", remote]);
  if (url !== clone) throw new Error(`remote '${remote}' already exists pointing at ${url}, not ${clone}`);
}

/** What the lane would bring in: the commit list and the scope diff. */
function showScope(repo: string, into: string, ref: string): void {
  const log = git(repo, ["log", "--oneline", `${into}..${ref}`]);
  console.log(`commits ahead of ${into}:\n${log || "(none — nothing to merge)"}`);
  const stat = git(repo, ["diff", "--stat", `${into}...${ref}`]);
  console.log(`scope diff (${into}...${ref}):\n${stat || "(empty)"}`);
}

function printChecklist(): void {
  console.log(`dry run — nothing merged. Before merging (re-run with --merge):
  [ ] the lane agent is terminal
  [ ] the scope diff above is reviewed: expected files only
  [ ] after the merge: full gates + e2e on the integrated tree`);
}

function mergeLane(repo: string, branch: string, ref: string): void {
  const subject = git(repo, ["log", "-1", "--format=%s", ref]);
  const result = attempt(repo, ["merge", "--no-ff", ref, "-m", `merge: ${branch} (${subject})`]);
  if (result.ok) {
    console.log(result.stdout);
    return;
  }
  const conflicted = attempt(repo, ["diff", "--name-only", "--diff-filter=U"]);
  const files = conflicted.ok ? conflicted.stdout : conflicted.stderr;
  throw new Error(`merge failed; nothing cleaned up. Conflicted files:\n${files || "(none reported)"}`);
}

async function absorbLane(args: Parsed): Promise<void> {
  const parent = args.dir ?? DEFAULT_PARENT;
  const clone = join(parent, `cow-lane-${args.name}`);
  if (!(await pathExists(clone))) throw new Error(`lane clone not found: ${clone}`);
  const branch = `lane-${args.name}`;
  const tip = precheck(clone, branch);

  const repo = gitRoot(process.cwd());
  if (resolve(repo) === resolve(clone)) {
    throw new Error("refusing: the current repository is the lane clone itself; run absorb from the main repo");
  }
  const into = args.into ?? "main";
  const current = currentBranch(repo);
  if (current !== into) {
    throw new Error(`refusing: absorb integrates into '${into}' but ${repo} is on '${current}'; check out '${into}' first`);
  }
  const remote = `lane-${args.name}`;
  addRemote(repo, remote, clone);
  git(repo, ["fetch", remote, branch]);

  const fetched = git(repo, ["rev-parse", `${remote}/${branch}`]);
  if (fetched !== tip) {
    throw new Error(`lane moved while absorbing: pinned ${tip}, fetched ${fetched}. Re-run absorb.`);
  }
  showScope(repo, into, `${remote}/${branch}`);

  if (!args.merge) {
    printChecklist();
    return;
  }
  mergeLane(repo, branch, `${remote}/${branch}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.verb === "spawn") await spawnLanes(args);
  else await absorbLane(args);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`lane: ${error.message}\n\n${USAGE}`);
  } else {
    console.error(`lane: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
