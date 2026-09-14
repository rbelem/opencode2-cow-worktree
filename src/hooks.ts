/**
 * The post-create hook runner — the impure tail of the `cow` create flow.
 *
 * Commands the plugin option `hooks.postCreate` configures, run against every
 * Worktree the strategy materializes — the tail of the create flow, so every
 * entry path (the HTTP API, the TUI, and the `spawn_workspace` tool, which
 * registers the same strategy object) gets them. Attach never reaches this
 * code: it binds a session to an existing directory and clones nothing.
 *
 * Split out of `strategy.ts` so the strategy is the thin
 * composition layer: it closes over the validated hook list and calls
 * `runPostCreateHooks` after a successful clone; this module owns the
 * mechanics of running the commands and turning a failure into the
 * leave-nothing-behind error.
 */
import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Runs the configured hooks sequentially against a freshly cloned worktree.
 *
 * Each command runs via `sh -c`, with the worktree as its cwd and
 * `COW_WORKTREE_PATH` / `COW_SOURCE_DIRECTORY` (both absolute) in its
 * environment, so a command that needs a per-project value can read one. The
 * first failure aborts creation: the just-created clone is removed — the same
 * leave-nothing-behind contract as the clone's own failure path — and the
 * error names the failed command and its 1-based step.
 */
export async function runPostCreateHooks(
  postCreate: readonly string[],
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
 * leave-nothing-behind cleanup as the clone's own failure path. The in-place
 * `rm` — not the quarantine of src/removal.ts — is acceptable here:
 * the directory is a seconds-old clone the strategy itself just created, so
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
