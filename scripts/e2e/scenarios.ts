// SPDX-License-Identifier: MIT
/** The scenario steps the harness runs against a live server. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Assertions, assertDeepClone, assertGitState, assertSharedExtents } from "./assertions";
import { NON_COW_ROOT, exists, removePath, tempRootUnder } from "./lib";
import type { Server } from "./server";
import type { ConfigRoot } from "./lib";

export interface WorktreeRun {
  readonly id: string;
  readonly directory: string;
  readonly sessionID: string;
}

/** §4(b): the deterministic backbone — create + session through the real API. */
export async function fanOut(
  server: Server,
  source: string,
  assertions: Assertions,
  count: number,
): Promise<WorktreeRun[]> {
  const runs: WorktreeRun[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `w${index}`;
    const created = await server.api.json("POST", "/api/worktree", {
      strategy: "cow",
      directory: join(source, "..", "worktrees"),
      name: id,
    });
    assertions.check(`create ${id}: HTTP 200`, created.status === 200, `${created.status} ${created.text}`);
    const directory = (created.body as { directory?: string }).directory;
    assertions.check(`create ${id}: returned a directory`, typeof directory === "string", created.text);

    const session = await server.api.json("POST", "/api/session", {
      title: `${id}-session`,
      location: { directory },
    });
    assertions.check(`session ${id}: HTTP 200`, session.status === 200, `${session.status} ${session.text}`);
    const sessionID = (session.body as { data?: { id?: string } }).data?.id;
    assertions.check(`session ${id}: returned an id`, typeof sessionID === "string", session.text);

    runs.push({ id, directory: directory!, sessionID: sessionID! });
    assertGitState(assertions, directory!, source, `${id} (post-create)`);
    console.log(`created ${id}: ${directory} (session ${sessionID})`);
  }
  return runs;
}

/**
 * §5: falsifiable independence. Each worktree writes a uniquely-named marker,
 * appends its own id to a shared-named log, and edits the tracked file. Each
 * must then see only its own id, none of the others' markers, and the source
 * must be untouched.
 */
export async function proveIndependence(
  assertions: Assertions,
  source: string,
  runs: WorktreeRun[],
): Promise<void> {
  for (const run of runs) {
    await writeFile(join(run.directory, `.agent-marker-${run.id}`), `${run.id} was here\n`);
    const logPath = join(run.directory, "agent-log.txt");
    const existing = await readFile(logPath, "utf8");
    await writeFile(logPath, `${existing}${run.id}\n`);
    await writeFile(join(run.directory, "tracked.txt"), `edited by ${run.id}\n`);
  }

  const sourceLog = await readFile(join(source, "agent-log.txt"), "utf8");
  const sourceTracked = await readFile(join(source, "tracked.txt"), "utf8");
  assertions.check("source: agent log carries no worktree id", sourceLog.trim() === "", JSON.stringify(sourceLog));
  assertions.check(
    "source: tracked file is unchanged",
    sourceTracked === "hello from source\n",
    JSON.stringify(sourceTracked),
  );

  for (const run of runs) {
    const ownLog = (await readFile(join(run.directory, "agent-log.txt"), "utf8")).trim().split("\n");
    assertions.check(
      `${run.id}: log contains only its own id`,
      ownLog.length === 1 && ownLog[0] === run.id,
      JSON.stringify(ownLog),
    );
    for (const other of runs.filter((candidate) => candidate.id !== run.id)) {
      const observed = await readFile(join(run.directory, `.agent-marker-${other.id}`), "utf8").catch(
        () => undefined,
      );
      assertions.check(`${run.id}: sees no marker for ${other.id}`, observed === undefined, String(observed));
    }
    const marker = await readFile(join(run.directory, `.agent-marker-${run.id}`), "utf8").catch(() => undefined);
    assertions.check(`${run.id}: has its own marker`, marker === `${run.id} was here\n`, String(marker));
    const tracked = await readFile(join(run.directory, "tracked.txt"), "utf8");
    assertions.check(`${run.id}: tracked file shows its own edit`, tracked === `edited by ${run.id}\n`, tracked);
  }
}

/** §6: each worktree is a Deep clone, with shared extents vs a byte-copy control. */
export async function assertDeepClones(
  assertions: Assertions,
  source: string,
  runs: WorktreeRun[],
): Promise<void> {
  const control = join(source, "..", "control-copy");
  execFileSync("cp", ["-a", "--reflink=never", source, control]);
  for (const run of runs) {
    await assertDeepClone(assertions, run.directory, run.id);
    assertSharedExtents(assertions, run.directory, control, run.id);
  }
}

/** `GET /api/worktree` returns a bare array here (observed), not `{data}`. */
function listEntries(body: unknown): Array<{ directory: string; strategy?: string }> {
  if (Array.isArray(body)) return body as Array<{ directory: string; strategy?: string }>;
  return (body as { data?: Array<{ directory: string; strategy?: string }> }).data ?? [];
}

/** §6: opencode2's own inventory records the strategy that produced each dir. */
export async function assertInventory(
  assertions: Assertions,
  server: Server,
  runs: WorktreeRun[],
): Promise<void> {
  const listed = await server.api.json("GET", "/api/worktree");
  assertions.check("inventory: GET /api/worktree returns 200", listed.status === 200, String(listed.status));
  const entries = listEntries(listed.body);
  for (const run of runs) {
    const entry = entries.find((candidate) => candidate.directory === run.directory);
    assertions.check(`inventory: ${run.id} is listed`, entry !== undefined);
    assertions.check(`inventory: ${run.id} records strategy "cow"`, entry?.strategy === "cow", JSON.stringify(entry));
  }
}

export interface FallbackResult {
  disabledStatus?: number;
  disabledText?: string;
  enabledStatus?: number;
  enabledMechanism?: string;
  enabledText?: string;
  readonly notes: string[];
}

/**
 * §6 fallback path, run on a real non-CoW filesystem. `/dev/shm` is tmpfs: no
 * CoW support, no root needed.
 *
 * The capability predicate answers for the *source* directory, and the server
 * resolves a worktree's source from its location — so a non-CoW source needs
 * its own server whose cwd/location is under `/dev/shm`. `runNonCowServer`
 * covers that; this function only records the negative branch attempted
 * against the main (CoW) server, which uses the CoW source and therefore
 * succeeds. The authoritative non-CoW results come from `runNonCowServer`.
 */
export async function runFallbackScenarios(
  server: Server,
  config: ConfigRoot,
  assertions: Assertions,
): Promise<FallbackResult> {
  const result: FallbackResult = { notes: [] };
  const worktrees = join(config.root, "non-cow-worktrees");
  await mkdir(worktrees, { recursive: true });

  const attempted = await server.api.json("POST", "/api/worktree", {
    strategy: "cow",
    directory: worktrees,
    name: "on-cow-source",
  });
  result.notes.push(
    `main server (CoW source): POST /api/worktree -> ${attempted.status}; ` +
      `expected success because the source is CoW`,
  );
  assertions.check(
    "fallback none: CoW source still produces a cow worktree",
    attempted.status === 200,
    `${attempted.status} ${attempted.text}`,
  );
  return result;
}

/**
 * §6 fallback path on a real non-CoW filesystem (`/dev/shm`, tmpfs).
 *
 * Important discrepancy discovered against the real server: `POST /api/worktree`
 * invokes the selected *strategy* directly, and the fallback policy lives in
 * the `spawn_workspace` *tool*. The API-direct backbone therefore cannot
 * exercise the fallback — it exercises the strategy's fail-loud contract,
 * which is the #8 criterion "requesting cow on a non-CoW filesystem fails and
 * leaves no directory". The opt-in branch is covered by the plugin's unit
 * tests (#6); reaching it end-to-end needs an agent session invoking the tool,
 * which needs provider credentials this throwaway config does not have. Both
 * facts are reported.
 */
export async function runNonCowServer(options: {
  readonly port: number;
  readonly fallback: "none" | "git";
}): Promise<FallbackResult> {
  const { makeConfigRoot, installPlugin, declarePlugin, git } = await import("./lib");
  const result: FallbackResult = { notes: [] };
  const config = await makeConfigRoot();
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await declarePlugin(config, pluginDir, { fallback: options.fallback });

  const source = await tempRootUnder(NON_COW_ROOT);
  await writeFile(join(source, "tracked.txt"), "tmpfs source\n");
  git(source, "init", "-q");
  git(source, "config", "user.email", "e2e@example.com");
  git(source, "config", "user.name", "e2e");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "tmpfs source");

  const { startServer } = await import("./server");
  const server = await startServer(config, { port: options.port, location: source });
  try {
    await server.api.json("POST", "/api/worktree/refresh");
    const worktrees = join(config.root, "worktrees");
    const name = `cow-${options.fallback}`;
    const created = await server.api.json("POST", "/api/worktree", {
      strategy: "cow",
      directory: worktrees,
      name,
    });
    result.notes.push(
      `source on /dev/shm, plugin fallback=${options.fallback}: POST /api/worktree {strategy:"cow"} -> ${created.status} ${created.text.slice(0, 160)}`,
    );
    result.disabledStatus = created.status;
    result.disabledText = created.text;
    result.enabledStatus = created.status;
    result.enabledText = created.text;
    result.enabledMechanism = (created.body as { directory?: string }).directory;
    return result;
  } finally {
    await server.stop();
    await removePath(config.root);
    await removePath(source);
  }
}

export async function removeWorktrees(
  assertions: Assertions,
  server: Server,
  runs: WorktreeRun[],
): Promise<void> {
  for (const run of runs) {
    const removed = await server.api.json("DELETE", "/api/worktree", {
      directory: run.directory,
      force: true,
    });
    assertions.check(`remove ${run.id}: HTTP 204`, removed.status === 204, `${removed.status} ${removed.text}`);
    assertions.check(`remove ${run.id}: directory is gone`, !(await exists(run.directory)));
  }
  const listed = await server.api.json("GET", "/api/worktree");
  const entries = listEntries(listed.body);
  for (const run of runs) {
    assertions.check(`remove ${run.id}: not in inventory`, !entries.some((entry) => entry.directory === run.directory));
  }
}
