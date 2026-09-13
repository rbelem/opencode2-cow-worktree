import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorktreeDefinition } from "../types/opencode2-worktree";
import { cloneDirectory } from "./clone";
import { mayRemove } from "./dirty";
import { removeQuarantined } from "./removal";
import {
  assertSameDevice,
  deviceOf,
  nearestExistingDevice,
} from "./tool";

/**
 * The `cow` Strategy: materialize a Worktree as a Deep clone.
 *
 * `create` reflinks the source working directory — ignored files included —
 * into the directory opencode2 has already chosen. It fails loudly rather than
 * falling back: the CoW capability predicate belongs to the caller-facing tool,
 * so a request for `cow` either clones or throws. `list` returns nothing on
 * purpose — opencode2 reads its own records for inventory, so a Strategy is not
 * the source of truth for what exists.
 *
 * opencode2 may hand the strategy a target on a different filesystem (its
 * default worktree parent is under the data directory). A reflink cannot cross
 * a device boundary, so the strategy pre-flights the same device rule the tool
 * applies and throws an actionable error before any directory is created; it
 * does not relocate the target, because a caller-supplied path is not the
 * strategy's to silently override.
 *
 * When the plugin option `hooks.postCreate` is configured, the clone is
 * followed by those commands — sequentially, in the worktree, with the source
 * and worktree paths in the environment — and the first failure removes the
 * clone before the error propagates, so a failed setup never leaves an orphan
 * clone behind. With no hooks configured the flow is byte-identical to the
 * unhooked one below.
 */
export const cowStrategy: WorktreeDefinition = {
  id: "cow",

  async create(input, { signal }) {
    signal.throwIfAborted();
    // Thrown outside the try so the actionable message is not rewrapped as a
    // generic clone failure. `input.directory` is the final target opencode2
    // has assembled; it may not exist yet, so the device of its nearest
    // existing ancestor decides whether a reflink can land there.
    const [sourceDevice, targetDevice] = await Promise.all([
      deviceOf(input.sourceDirectory),
      nearestExistingDevice(input.directory, deviceOf),
    ]);
    assertSameDevice(input.sourceDirectory, sourceDevice, input.directory, targetDevice);
    try {
      await cloneDirectory(input.sourceDirectory, input.directory);
    } catch (cause) {
      // Leave nothing behind: cloneDirectory creates the target before it can
      // fail, so a partial tree would otherwise survive a failed create.
      // In-place `rm` — not the quarantine dance of src/removal.ts — is
      // acceptable here: the directory is a seconds-old clone this call itself
      // just created, so the provenance is known and there is no audit gap.
      await rm(input.directory, { recursive: true, force: true });
      throw new Error(`cow strategy failed to clone into ${input.directory}`, {
        cause,
      });
    }
    await runPostCreateHooks(input.directory, input.sourceDirectory);
    return { directory: input.directory };
  },

  async remove(input) {
    // opencode2's `force` is its two-phase confirm protocol — "proceed despite
    // uncommitted changes" — not `rm`'s "ignore a missing path" flag. The
    // built-in git strategy maps it to `git worktree remove --force` and
    // refuses while the worktree is dirty; the TUI turns the refusal into a
    // confirmation and retries with `force: true`. So the probe is skipped
    // entirely once the user has confirmed, and `rm` always receives a literal
    // `force: true` (a directory this call is authorized to delete may
    // legitimately be gone already).
    //
    // At `force: false` a dirty — or unknowable — directory refuses before any
    // filesystem change, so uncommitted work is never silently destroyed
    // (issue #13). `input.force` is authorization for the decision, not a flag
    // for `rm`.
    //
    // Past the guard the deletion is never in-place: the directory's identity
    // is captured, it is renamed to a quarantine sibling, the identity is
    // re-confirmed, and only then is the copy deleted — so a swapped or
    // recycled path can never be deleted in the audited directory's name, and
    // an agent holding a cwd inside stops blocking the path. `removal.ts` owns
    // those mechanics.
    const uncommitted = input.force
      ? undefined
      : await probeUncommitted(input.directory);
    const decision = mayRemove({ force: input.force, uncommitted });
    if (!decision.remove) {
      throw new Error(
        `cow refuses to remove ${input.directory} without force: ${decision.reason}. ` +
          "Re-run with force to delete them.",
      );
    }
    await removeQuarantined(input.directory);
  },

  async list() {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Post-create hooks (plugin option `hooks.postCreate`)
//
// Commands the plugin option configures, run against every Worktree this
// strategy materializes — the tail of the create flow, so every entry path
// (the HTTP API, the TUI, and the `spawn_workspace` tool, which registers the
// same strategy object) gets them. Attach never reaches this code: it binds a
// session to an existing directory and clones nothing.
// ---------------------------------------------------------------------------

/**
 * The validated post-create hooks, in run order. Empty means none. Installed
 * once by the plugin's setup, which is the only place the plugin's `options`
 * are reachable; the strategy itself receives none from opencode2.
 */
let postCreate: readonly string[] = [];

/**
 * Installs the post-create hooks `postCreateHooks` validated from the plugin's
 * options. Called from the plugin's `setup`, before the strategy is
 * registered, so every later create reads the configured list.
 */
export function setPostCreateHooks(commands: readonly string[]): void {
  postCreate = commands;
}

/**
 * Runs the configured hooks sequentially against a freshly cloned worktree.
 *
 * Each command runs via `sh -c`, with the worktree as its cwd and
 * `COW_WORKTREE_PATH` / `COW_SOURCE_DIRECTORY` (both absolute) in its
 * environment, so a command that needs a per-project value can read one. The
 * first failure aborts creation: the just-created clone is removed — the same
 * leave-nothing-behind contract as the clone's own failure path above — and
 * the error names the failed command and its 1-based step.
 */
export async function runPostCreateHooks(
  worktree: string,
  sourceDirectory: string,
): Promise<void> {
  for (const [index, command] of postCreate.entries()) {
    try {
      await runHookCommand(command, worktree, sourceDirectory);
    } catch (cause) {
      throw await failedCreate(worktree, command, index + 1, postCreate.length, cause);
    }
  }
}

/**
 * Turns a hook failure into the create flow's error, after the same
 * leave-nothing-behind cleanup as the clone's own failure path above. The
 * in-place `rm` — not the quarantine of src/removal.ts — is acceptable here:
 * the directory is a seconds-old clone this strategy itself just created, so
 * the provenance is known and there is no audit gap to protect. When the
 * cleanup itself fails, the hook error still wins: the message keeps the
 * command, step, and output, notes the failed cleanup, and names where the
 * remains are.
 */
async function failedCreate(
  worktree: string,
  command: string,
  step: number,
  total: number,
  cause: unknown,
): Promise<Error> {
  const failure = hookFailure(command, step, total, cause);
  try {
    await rm(worktree, { recursive: true, force: true });
  } catch (cleanup) {
    const detail = cleanup instanceof Error ? cleanup.message : String(cleanup);
    return new Error(
      `${failure.message} Removing the worktree also failed (${detail}), so ` +
        `the remains are left at ${worktree}.`,
      { cause },
    );
  }
  return failure;
}

/**
 * How long one post-create command may run before it is killed and counts as a
 * failure, with the same cleanup as any other failure. The primary use case is
 * dependency installation — a cold `corepack use pnpm@latest` or
 * `bun install` can legitimately run for minutes — so the budget is generous;
 * a command that still hangs after five minutes is stuck, not slow.
 */
const HOOK_TIMEOUT_MS = 300_000;

/**
 * How much of a hook's combined output `execFile` may buffer before the
 * command is rejected as an output-limit failure. Node's default, made
 * explicit so the failure message can name the number.
 */
const HOOK_MAX_BUFFER = 1024 * 1024;

/**
 * Runs one hook command. Exported as the seam the timeout test drives with a
 * short explicit timeout — the production path always uses `HOOK_TIMEOUT_MS`
 * through the default parameter, like `probeUncommitted`'s injected seam.
 *
 * The command gets no stdin: the script opens with `exec 0</dev/null`, and
 * `stdio[0] = "ignore"` backs it up on runtimes that honor it (Bun 1.4.2 does
 * not — without the redirect, a hook that reads stdin hangs to the timeout).
 * `worktree` and `sourceDirectory` are resolved to absolute before they reach
 * the cwd or the environment, so the absolute-path contract holds by
 * construction whatever the caller handed over.
 */
export async function runHookCommand(
  command: string,
  worktree: string,
  sourceDirectory: string,
  timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<void> {
  const worktreePath = resolve(worktree);
  const sourcePath = resolve(sourceDirectory);
  // `execFile`'s types omit `stdio` (its promise overloads assume piped
  // streams), but the runtime accepts it; stdin "ignore" backs up the
  // in-script redirect on runtimes that honor it — Bun 1.4.2 does not.
  const options = {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: HOOK_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      COW_WORKTREE_PATH: worktreePath,
      COW_SOURCE_DIRECTORY: sourcePath,
    },
  } as unknown as ExecFileOptionsWithStringEncoding;
  await run("sh", ["-c", `exec 0</dev/null; ${command}`], options);
}

/**
 * What `execFile`'s rejection carries about a failed, signalled, or killed
 * command — the shapes Bun 1.4.2 actually produces (probed at runtime):
 *
 * - exit failure: `code` is the numeric exit status, `signal` absent or null.
 * - signal death: `signal` is the signal name, `code` null, `killed` false.
 * - timeout kill: `killed` true, `signal` "SIGTERM", `code` null.
 * - output past `maxBuffer`: `code` names the limit (Bun:
 *   "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"; Node: "ENOBUFS").
 */
interface CommandFailure {
  readonly killed?: boolean;
  readonly signal?: unknown;
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/**
 * The codes `execFile` rejects with when a stream exceeds `maxBuffer`, across
 * the runtimes this plugin runs on.
 */
const MAXBUFFER_CODES = new Set(["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ENOBUFS"]);

/**
 * Why a hook command failed, ordered by what the real rejection shapes decide
 * it: an output-limit rejection names itself in `code` before anything else;
 * `killed` separates the timeout kill (which also carries a signal) from a
 * signal death; a numeric `code` is an exit status. The "300s" wording is
 * truthful everywhere this can be produced: `hookFailure` is only reached
 * through `runPostCreateHooks`, which always runs hooks with the
 * `HOOK_TIMEOUT_MS` default — the injected-timeout seam bypasses it.
 */
function failureReason(failure: CommandFailure): string {
  const code = failure.code;
  if (typeof code === "string" && MAXBUFFER_CODES.has(code)) {
    return "output limit exceeded (1 MiB)";
  }
  if (failure.killed) return "timed out after 300s";
  if (failure.signal != null) return `terminated by ${String(failure.signal)}`;
  if (typeof code === "number") return `exit code ${code}`;
  return `terminated by ${String(code)}`;
}

/**
 * The hook failure: which command, which 1-based step, how it failed, and —
 * because a hook's output is the only record of what a failed setup tried to
 * say — its captured stdout and stderr.
 */
function hookFailure(
  command: string,
  step: number,
  total: number,
  cause: unknown,
): Error {
  const failure = cause as CommandFailure;
  return new Error(
    `post-create hook failed (step ${step} of ${total}): ${command} ` +
      `(${failureReason(failure)})` +
      capturedOutput(failure),
    { cause },
  );
}

/** How much of a failed hook's combined output an error message carries. */
const CAPTURE_LIMIT = 2048;

/**
 * The captured stdout and stderr of a failed hook; absent when both are empty.
 * A hook's output is the only record of what a failed setup tried to say, but
 * a megabyte of it does not belong inside an error message, so past
 * `CAPTURE_LIMIT` only the last chunk is kept, behind a truncation marker.
 */
function capturedOutput(failure: CommandFailure): string {
  const streams = [failure.stdout, failure.stderr]
    .map((stream) => (typeof stream === "string" ? stream.trim() : ""))
    .filter((stream) => stream !== "");
  if (streams.length === 0) return "";
  const capture = streams.join("\n");
  if (capture.length > CAPTURE_LIMIT) {
    return `\n--- output ---\n…output truncated…\n${capture.slice(-CAPTURE_LIMIT)}`;
  }
  return `\n--- output ---\n${capture}`;
}

/** How long `git status` may take before the probe gives up and reports unknown. */
const GIT_TIMEOUT_MS = 5_000;

const run = promisify(execFile);

/**
 * Reports the paths a worktree has uncommitted changes in, or `undefined` when
 * that cannot be determined. A probe that fails is never "clean".
 *
 * The metadata gate keeps the probe off a non-repository directory: without
 * `.git` (a file, as in a linked worktree, or a directory, as in a clone) no
 * porcelain status exists, so the answer is unknown and `remove` refuses. A
 * directory that is gone answers `undefined` too — `stat` following a symlink
 * is intentional, because a symlinked worktree still owns git metadata.
 *
 * Injected through a module-level `spyOn` seam in the tests, like `deviceOf`:
 * `bun:test` can replace an export the module itself calls. The call is
 * deliberately unqualified and outside destructuring so that replacement
 * takes effect.
 *
 * `execFile` runs `git` directly — no shell, no inherited prompt — and CI=1
 * suppresses any credential or editor interaction; the 5s timeout bounds a
 * git that hangs on a lock. A pager needs a tty and is never started by
 * `status --porcelain` here. Any error, non-zero exit, or timeout is unknown.
 */
export async function probeUncommitted(
  directory: string,
): Promise<readonly string[] | undefined> {
  if (!(await hasGitMetadata(directory))) return undefined;
  try {
    const { stdout } = await run(
      "git",
      ["-C", directory, "status", "--porcelain"],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_PAGER: "cat", GIT_EDITOR: "true", CI: "1" },
      },
    );
    return porcelainPaths(stdout);
  } catch {
    return undefined;
  }
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The changed paths in `git status --porcelain` output. The status and the
 * path are separated by the first space; a rename's `old -> new` is kept
 * whole, because both ends name something the user would lose.
 */
function porcelainPaths(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter((path) => path.length > 0);
}
