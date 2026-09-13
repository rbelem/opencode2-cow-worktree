import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runHookCommand } from "../src/hooks";

// The hook runner's own mechanics, pinned where the code lives (src/hooks.ts):
// the absolute-path env contract, the stdin-at-EOF guarantee, and the real
// timeout rejection shape. The strategy-level flow — hooks wired through the
// plugin option, failures cleaning the clone — is pinned in
// test/strategy.test.ts.

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A plain scratch directory with a source inside; no git and no CoW required. */
async function makeHookScratch(prefix: string): Promise<{ dir: string; source: string; target: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const source = join(dir, "source");
  await mkdir(source);
  return { dir, source, target: join(dir, "clone") };
}

test("relative worktree and source paths reach the hook env as absolute", async () => {
  // The env contract is absolute by construction, not by the caller's care:
  // whatever paths the runner is handed are resolved before they are
  // installed, so a relative input still yields the absolute value.
  const { source, target } = await makeHookScratch("cow-hooks-rel-");
  await mkdir(target, { recursive: true });

  await runHookCommand(
    'printf "%s" "$COW_WORKTREE_PATH" > hook-worktree.txt; ' +
      'printf "%s" "$COW_SOURCE_DIRECTORY" > hook-source.txt',
    relative(process.cwd(), target),
    relative(process.cwd(), source),
  );

  expect(await readFile(join(target, "hook-worktree.txt"), "utf8")).toBe(resolve(target));
  expect(await readFile(join(target, "hook-source.txt"), "utf8")).toBe(resolve(source));
});

test("a hook that reads stdin does not hang until the timeout", async () => {
  // `cat` blocks on an open stdin pipe; with the hook's stdin at EOF it exits
  // immediately. The 500ms budget keeps a regression (stdin left open) a fast
  // timeout rejection instead of a hang.
  const { source, target } = await makeHookScratch("cow-hooks-stdin-");
  await mkdir(target, { recursive: true });

  await expect(runHookCommand("cat", target, source, 500)).resolves.toBeUndefined();
});

test("a timed-out hook counts as a failure, with the real rejection shape", async () => {
  // The real mechanism, with the real shape pinned (probed on Bun 1.4.2):
  // execFile's timeout kills the command — killed true, signal SIGTERM, code
  // null — and rejects. The target must exist for the timeout, not a spawn
  // error, to be what rejects.
  const { source, target } = await makeHookScratch("cow-hooks-timeout-cmd-");
  await mkdir(target, { recursive: true });
  const error = await runHookCommand("sleep 5", target, source, 50).then(
    () => undefined,
    (failure: unknown) =>
      failure as Error & { killed?: boolean; signal?: unknown; code?: unknown },
  );

  expect(error?.killed).toBe(true);
  expect(error?.signal).toBe("SIGTERM");
  expect(error?.code).toBeNull();
});
