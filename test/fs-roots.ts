import { homedir, tmpdir } from "node:os";
import { probeCowCapability } from "../src/capability";

/**
 * Discover the filesystem roots the filesystem-dependent tests need — one that
 * genuinely satisfies a CoW clone, one that definitively refuses it — so those
 * tests run where the environment supports them and skip where it does not,
 * instead of hardcoding this machine's mounts.
 *
 * The probe is `probeCowCapability`, the same predicate the plugin uses: it
 * attempts a real forced reflink of a temporary file and classifies a failure
 * as a definitive `unsupported` (EOPNOTSUPP/ENOTSUP/ENOTTY/EINVAL/EXDEV/ENOSYS)
 * or as an unexpected `error`. Only a definitive negative can answer "this
 * filesystem cannot clone"; an error never does. `probeCowCapability` caches
 * per directory, so a root is probed once per process.
 */

/**
 * Bases tried for a CoW root, most-specific first. `/tmp/opencode` is this
 * repository's historical btrfs scratch root, kept first so a machine that has
 * it keeps exercising it. The rest mirror `test/capability.test.ts`.
 */
const COW_CANDIDATES = [
  ...new Set(["/tmp/opencode", homedir(), tmpdir(), process.cwd()]),
];

/**
 * Bases tried for a non-CoW root. `/dev/shm` is tmpfs on Linux (no CoW);
 * `tmpdir()`/`homedir()`/`cwd()` cover systems without it.
 */
const NON_COW_CANDIDATES = [
  ...new Set(["/dev/shm", tmpdir(), homedir(), process.cwd()]),
];

async function firstMatch(
  candidates: readonly string[],
  matches: (directory: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const directory of candidates) {
    if (await matches(directory)) return directory;
  }
  return undefined;
}

/**
 * A directory whose filesystem can satisfy a CoW clone, or `undefined` when no
 * candidate can. Pass an explicit candidate list to test the discovery path
 * without depending on the machine's mounts.
 */
export function findCowRoot(
  candidates: readonly string[] = COW_CANDIDATES,
): Promise<string | undefined> {
  return firstMatch(candidates, async (directory) => {
    const result = await probeCowCapability(directory);
    return result.status === "supported";
  });
}

/**
 * A directory whose filesystem definitively cannot clone, or `undefined` when
 * no candidate reports one. An unexpected probe error (permissions, a missing
 * path) does not qualify.
 */
export function findNonCowRoot(
  candidates: readonly string[] = NON_COW_CANDIDATES,
): Promise<string | undefined> {
  return firstMatch(candidates, async (directory) => {
    const result = await probeCowCapability(directory);
    return result.status === "unsupported";
  });
}

/**
 * True when `git` is on PATH. Several tests build real scratch repositories
 * with it; on a machine without git those tests skip rather than fail for an
 * environment reason.
 */
export function hasGit(): boolean {
  return Bun.which("git") !== null;
}
