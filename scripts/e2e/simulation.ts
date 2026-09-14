// SPDX-License-Identifier: MIT
/**
 * The simulation scenario: drive a **real** session through the compiled-in
 * simulation harness.
 *
 * `OPENCODE_SIMULATE=1` swaps only the `HttpClient` layer for a
 * `SimulatedProvider`; `OPENCODE_DRIVE` starts a backend websocket that
 * answers the provider's `POST /v1/chat/completions` from `driveModel`'s
 * scripted turns. The session runner, tool registry, tool decoding, and the
 * plugin's tool execution are production code — only the model's bytes are
 * scripted.
 *
 * What this scenario establishes, and what it found, is recorded in
 * `docs/e2e/findings.md`. The short version: the loop is real (a scripted
 * `shell` call executes), but a plugin tool is **not** offered to the session,
 * so `spawn_workspace` cannot be invoked this way. The scenario asserts the
 * observed facts rather than an expectation that does not hold.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { MARKER_NAME } from "../../src/occupancy";
import { driveModel, type DriveController } from "./drive";
import { installPlugin, makeConfigRoot, removePath, declarePlugin, exists, git } from "./lib";
import type { ConfigRoot } from "./lib";
import type { Server } from "./server";

export interface SimulationResult {
  readonly notes: string[];
  toolNames: readonly string[];
  pluginToolOffered: boolean;
  readonly scriptedToolName: string;
  scriptedToolStatus?: string;
  scriptedToolOutput?: string;
  sessionID?: string;
  requests: number;
  driveEndpoint?: string;
}

/**
 * The provider entry that makes the session resolve a model without a DB
 * credential. `settings.apiKey` satisfies the configured-auth check, so no
 * `credential` row is needed.
 */
function simulationProviders(): Record<string, unknown> {
  return {
    sim: {
      name: "Simulation",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://api.openai.com/v1", apiKey: "simulation", provider: "sim" },
      models: { sim: {} },
    },
  };
}

/** Merge the simulation provider into an existing config, never clobbering it. */
async function mergeSimulationConfig(
  configRoot: string,
  plugins: readonly { package: string; options: Record<string, unknown> }[],
): Promise<void> {
  await writeFile(
    join(configRoot, "opencode.json"),
    `${JSON.stringify({ plugins, providers: simulationProviders() }, null, 2)}\n`,
  );
}

/**
 * Boots a server under `OPENCODE_SIMULATE=1` + `OPENCODE_DRIVE=1`, attaches the
 * drive controller, runs a real session, and scripts one tool call.
 *
 * The drive endpoint is parsed from the server's own
 * `opencode drive backend websocket: ws://…` line. Parsing the whole output
 * buffer is wrong here: stdout and stderr interleave without a separator, so
 * the endpoint must come from the matched line only.
 */
export async function runSimulationScenario(options: {
  readonly port: number;
  readonly fallback: "none" | "git";
  readonly scriptedTool: { readonly name: string; readonly input: unknown };
  /**
   * Where to create the scenario's source project. Defaults to the config root
   * (a CoW filesystem here). Point it at a non-CoW filesystem (e.g. tmpfs) to
   * exercise the fallback policy, but note opencode2 defaults the worktree
   * target to its data directory, so a source on another device fails with
   * `EXDEV` before the fallback policy is consulted unless the tool is given a
   * same-device target.
   */
  readonly sourceRoot?: string;
}): Promise<SimulationResult> {
  const result: SimulationResult = {
    notes: [],
    toolNames: [],
    pluginToolOffered: false,
    scriptedToolName: options.scriptedTool.name,
    requests: 0,
  };
  const config = await makeConfigRoot();
  config.env.OPENCODE_SIMULATE = "1";
  config.env.OPENCODE_DRIVE = "1";
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await mergeSimulationConfig(config.config, [{ package: pluginDir, options: { fallback: options.fallback } }]);

  const source = join(options.sourceRoot ?? config.root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "tracked.txt"), "simulation source\n");
  git(source, "init", "-q");
  git(source, "config", "user.email", "e2e@example.com");
  git(source, "config", "user.name", "e2e");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "simulation source");

  const { startServer } = await import("./server");
  const server = await startServer(config, { port: options.port, location: source });
  let drive: DriveController | undefined;
  try {
    const endpoint = driveEndpoint(server);
    result.driveEndpoint = endpoint;
    result.notes.push(`drive backend websocket: ${endpoint}`);

    drive = await driveModel(endpoint, [
      {
        kind: "tool-call",
        name: options.scriptedTool.name,
        input: resolveScriptedInput(options.scriptedTool.input, source),
      },
      { kind: "text", text: "done" },
    ]);
    result.notes.push("drive controller attached (simulation.handshake + llm.attach)");

    const session = await server.api.json("POST", "/api/session", {
      title: "simulation",
      location: { directory: source },
      model: { providerID: "sim", id: "sim" },
    });
    const sessionID = (session.body as { data?: { id?: string } }).data?.id;
    result.sessionID = sessionID;
    result.notes.push(`session create -> ${session.status} ${sessionID ?? session.text.slice(0, 120)}`);

    const prompted = await server.api.json("POST", `/api/session/${sessionID}/prompt`, {
      text: "Create a worktree.",
      model: { providerID: "sim", id: "sim" },
    });
    result.notes.push(`prompt -> ${prompted.status}`);

    await Promise.race([drive.done, Bun.sleep(20_000).then(() => undefined)]);
    result.requests = drive.requests.length;
    const toolNames = [...new Set(drive.toolNames)];
    result.toolNames = toolNames;
    result.pluginToolOffered = toolNames.includes("spawn_workspace");
    result.notes.push(
      `model offered ${toolNames.length} tools: ${toolNames.join(", ")}`,
    );
    result.notes.push(
      result.pluginToolOffered
        ? "spawn_workspace IS offered to the session"
        : "spawn_workspace is NOT offered to the session (plugin tool unreachable)",
    );

    await Bun.sleep(750);
    const messages = await server.api.json("GET", `/api/session/${sessionID}/message`);
    const scripted = findScriptedTool(messages.body, options.scriptedTool.name);
    if (scripted) {
      result.scriptedToolStatus = scripted.status;
      result.scriptedToolOutput = scripted.output;
      result.notes.push(
        `scripted ${options.scriptedTool.name} call -> ${scripted.status}: ${scripted.output?.slice(0, 160) ?? ""}`,
      );
    } else {
      result.notes.push(`scripted ${options.scriptedTool.name} call not found in the transcript`);
    }
    return result;
  } finally {
    drive?.close();
    await server.stop();
    await removePath(config.root);
  }
}

/**
 * Fills a scripted tool input's `sourceDirectory` with the scenario's own
 * source when the caller did not supply one. Scripting an arbitrary path is how
 * the first version of this scenario failed for reasons unrelated to the tool —
 * a source on a different device from opencode2's data directory makes the
 * clone fail with `EXDEV`, which is correct behaviour but tells us nothing
 * about the fallback.
 */
function resolveScriptedInput(input: unknown, source: string): unknown {
  if (typeof input !== "object" || input === null) return input;
  const record = input as Record<string, unknown>;
  if (record.sourceDirectory !== undefined && record.sourceDirectory !== "") return input;
  return { ...record, sourceDirectory: source };
}

/** The endpoint from the server's own drive line, never from a raw buffer split. */
export function driveEndpoint(server: Server): string {
  const line = server
    .output()
    .split("\n")
    .find((candidate) => candidate.includes("opencode drive backend websocket:"));
  if (!line) throw new Error("server did not print a drive backend websocket line");
  return line.split("opencode drive backend websocket: ")[1]!.trim();
}

interface ScriptedTool {
  readonly status: string;
  readonly output?: string;
}

/**
 * Reads the scripted tool call back out of the transcript. `session.message`
 * returns assistant messages whose `content` carries `{type:"tool", name,
 * state}`; the executed output is in `state.content` for a completed tool.
 */
function findScriptedTool(body: unknown, name: string): ScriptedTool | undefined {
  const messages = (body as { data?: Array<{ content?: Array<Record<string, unknown>> }> }).data ?? [];
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool" || part.name !== name) continue;
      const state = (part.state ?? {}) as {
        status?: string;
        content?: Array<{ text?: string }>;
        error?: { message?: string };
      };
      const output = (state.content ?? [])
        .map((entry) => entry.text ?? "")
        .join("")
        .trim();
      return {
        status: state.error?.message ? `${state.status ?? "unknown"} (${state.error.message})` : (state.status ?? "unknown"),
        output,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Attach (issue #1) + occupancy (issue #15)
//
// Real sessions invoke `spawn_workspace` with the same name against ONE
// server. Round 1 creates the worktree and writes its occupancy marker; round
// 2 must now be REFUSED by the guard — round 1's session is seconds-fresh —
// round 3 walks the refusal's own recovery (delete the occupying session out
// of band) and must attach and rewrite the marker, and a legacy raw worktree
// (created through the worktree API, which writes no marker) must attach as
// before and come out marked and clean. Everything below the drive controller
// is production code: the session loop, the tool registry, the plugin's tool
// execution, and opencode2's real worktree inventory.
// ---------------------------------------------------------------------------

export interface AttachResult {
  readonly notes: string[];
  /** The directory the first round produced, as the inventory records it. */
  worktreeDirectory?: string;
  firstStatus?: string;
  firstOutput?: string;
  secondStatus?: string;
  secondOutput?: string;
  /** How many inventory rows carry the scenario's worktree name after round 2. */
  inventoryCount?: number;
  /** The session id the marker named after round 1 — the occupant round 2 hit. */
  occupantSessionID?: string;
  /** DELETE /api/session/<occupant> before round 3. */
  deleteStatus?: number;
  thirdStatus?: string;
  thirdOutput?: string;
  /** The session id the round-3 attach reported in its own text. */
  thirdSessionID?: string;
  /** The session id the marker names after round 3 — must equal thirdSessionID. */
  thirdMarkerSessionID?: string;
  /** The legacy raw worktree (no marker): attach, marker, and cleanliness. */
  legacy?: {
    readonly directory?: string;
    attachStatus?: string;
    attachOutput?: string;
    markerSessionID?: string;
    gitStatus?: string;
  };
}

/** The scripted name the occupancy rounds ask for. */
const ATTACH_NAME = "att";

/**
 * The attach scenario: one server, scripted `spawn_workspace` calls with the
 * same name, one inventory.
 *
 * The scenario's source lives in the config root (a CoW filesystem), so the
 * worktree lands beside it as a sibling — the tool's default parent — and the
 * Deep-clone signature the attach check requires (`.git` as a directory) is
 * produced by the real first create.
 */
export async function runAttachScenario(options: {
  readonly port: number;
}): Promise<AttachResult> {
  const result: AttachResult = { notes: [] };
  const config = await makeConfigRoot();
  config.env.OPENCODE_SIMULATE = "1";
  config.env.OPENCODE_DRIVE = "1";
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await mergeSimulationConfig(config.config, [{ package: pluginDir, options: {} }]);

  const source = join(config.root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "tracked.txt"), "attach source\n");
  git(source, "init", "-q");
  git(source, "config", "user.email", "e2e@example.com");
  git(source, "config", "user.name", "e2e");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "attach source");

  const { startServer } = await import("./server");
  const server = await startServer(config, { port: options.port, location: source });
  try {
    const endpoint = driveEndpoint(server);
    result.notes.push(`drive backend websocket: ${endpoint}`);

    // Round 1: the named worktree does not exist yet, so the tool creates it
    // and marks it with the session it started there.
    const first = await runScriptedRound({ server, endpoint, source, round: 1, name: ATTACH_NAME, notes: result.notes });
    result.firstStatus = first.status;
    result.firstOutput = first.output;
    const rows = await inventoryRows(server);
    result.notes.push(`inventory after round 1: ${JSON.stringify(rows)}`);
    result.worktreeDirectory = rows.find(
      (entry) => basename(entry.directory) === ATTACH_NAME,
    )?.directory;

    // Round 2: the same name, seconds later. The occupancy guard must refuse —
    // round 1's session is fresh — and no second directory may appear.
    const second = await runScriptedRound({ server, endpoint, source, round: 2, name: ATTACH_NAME, notes: result.notes });
    result.secondStatus = second.status;
    result.secondOutput = second.output;
    result.inventoryCount = (await inventoryRows(server)).filter(
      (entry) => basename(entry.directory) === ATTACH_NAME,
    ).length;
    result.notes.push(`inventory after round 2: ${result.inventoryCount} row(s) named "${ATTACH_NAME}"`);

    // Round 3: the refusal's own recovery — delete the occupying session out
    // of band (verified: DELETE answers 204, then the session is gone) — and
    // the same name must now attach and rewrite the marker for the new session.
    result.occupantSessionID = await markerSessionID(result.worktreeDirectory);
    result.notes.push(`marker after round 1 names: ${result.occupantSessionID ?? "nothing"}`);
    if (result.occupantSessionID !== undefined) {
      const deleted = await server.api.json("DELETE", `/api/session/${result.occupantSessionID}`);
      result.deleteStatus = deleted.status;
      result.notes.push(`round 3: DELETE occupying session -> ${deleted.status}`);
    }
    const third = await runScriptedRound({ server, endpoint, source, round: 3, name: ATTACH_NAME, notes: result.notes });
    result.thirdStatus = third.status;
    result.thirdOutput = third.output;
    result.thirdSessionID = /session (\S+)\)/.exec(third.output ?? "")?.[1];
    result.thirdMarkerSessionID = await markerSessionID(result.worktreeDirectory);

    // Legacy phase: a worktree created through the raw worktree API (the
    // fanOut pattern) predates the guard — the strategy records the inventory
    // row but writes no marker. It must sit at the path the tool predicts for
    // the name (a sibling of the source), so the attach finds it. Its attach
    // must proceed exactly as before and leave the directory marked and clean.
    const legacyName = "legacy";
    const rawCreated = await server.api.json("POST", "/api/worktree", {
      strategy: "cow",
      directory: join(source, ".."),
      name: legacyName,
    });
    const legacyDir = (rawCreated.body as { directory?: string }).directory;
    result.legacy = { directory: legacyDir };
    result.notes.push(
      `legacy: POST /api/worktree -> ${rawCreated.status} ${legacyDir ?? rawCreated.text.slice(0, 120)}`,
    );
    const legacyRound = await runScriptedRound({ server, endpoint, source, round: 4, name: legacyName, notes: result.notes });
    result.legacy.attachStatus = legacyRound.status;
    result.legacy.attachOutput = legacyRound.output;
    result.legacy.markerSessionID = await markerSessionID(legacyDir);
    result.legacy.gitStatus =
      legacyDir === undefined
        ? undefined
        : execFileSync("git", ["-C", legacyDir, "status", "--porcelain"], { encoding: "utf8" });
    result.notes.push(
      `legacy: scripted spawn_workspace -> ${legacyRound.status ?? "not found"}` +
        `${legacyRound.output ? `: ${legacyRound.output.slice(0, 200)}` : ""}`,
    );
    result.notes.push(
      `legacy: marker names ${result.legacy.markerSessionID ?? "nothing"}; ` +
        `git status ${JSON.stringify(result.legacy.gitStatus)}`,
    );
    return result;
  } finally {
    await server.stop();
    await removePath(config.root);
  }
}

/**
 * One scripted session against a running simulation server: attach a fresh
 * drive controller, open a session, prompt it, and read the scripted tool call
 * back out of the transcript. Each round gets its own controller because each
 * answers exactly its own `llm.request` sequence.
 */
async function runScriptedRound(args: {
  readonly server: Server;
  readonly endpoint: string;
  readonly source: string;
  readonly round: number;
  readonly name: string;
  readonly notes: string[];
}): Promise<{ status?: string; output?: string }> {
  const drive = await driveModel(args.endpoint, [
    {
      kind: "tool-call",
      name: "spawn_workspace",
      input: resolveScriptedInput({ name: args.name }, args.source),
    },
    { kind: "text", text: "done" },
  ]);
  const session = await args.server.api.json("POST", "/api/session", {
    title: `attach-${args.round}`,
    location: { directory: args.source },
    model: { providerID: "sim", id: "sim" },
  });
  const sessionID = (session.body as { data?: { id?: string } }).data?.id;
  args.notes.push(`round ${args.round}: session create -> ${session.status} ${sessionID ?? session.text.slice(0, 120)}`);

  const prompted = await args.server.api.json("POST", `/api/session/${sessionID}/prompt`, {
    text: "Create a worktree.",
    model: { providerID: "sim", id: "sim" },
  });
  args.notes.push(`round ${args.round}: prompt -> ${prompted.status}`);

  await Promise.race([drive.done, Bun.sleep(20_000).then(() => undefined)]);
  await Bun.sleep(750);
  const messages = await args.server.api.json("GET", `/api/session/${sessionID}/message`);
  const scripted = findScriptedTool(messages.body, "spawn_workspace");
  drive.close();
  args.notes.push(
    `round ${args.round}: scripted spawn_workspace -> ${scripted?.status ?? "not found"}` +
      `${scripted?.output ? `: ${scripted.output.slice(0, 200)}` : ""}`,
  );
  return { status: scripted?.status, output: scripted?.output };
}

/** The session id a worktree's occupancy marker names, when readable. */
async function markerSessionID(directory: string | undefined): Promise<string | undefined> {
  if (directory === undefined) return undefined;
  const raw = await readFile(join(directory, MARKER_NAME), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const sessionID = (JSON.parse(raw) as { sessionID?: unknown }).sessionID;
    return typeof sessionID === "string" ? sessionID : undefined;
  } catch {
    return undefined;
  }
}

/** `GET /api/worktree` returns a bare array here (observed), not `{data}`. */
async function inventoryRows(server: Server): Promise<Array<{ directory: string; strategy?: string }>> {
  const listed = await server.api.json("GET", "/api/worktree");
  if (Array.isArray(listed.body)) return listed.body as Array<{ directory: string; strategy?: string }>;
  return (listed.body as { data?: Array<{ directory: string; strategy?: string }> }).data ?? [];
}

// ---------------------------------------------------------------------------
// list_worktrees (ADR 0003)
//
// Two worktrees are created through the real HTTP API — the cow strategy runs
// for real and records each row with strategy "cow" — then `list_worktrees` is
// executed through a real scripted session. The tool's answer must name both
// directories with strategy "cow", agreeing with the inventory it derives
// from.
// ---------------------------------------------------------------------------

export interface ListScenarioResult {
  readonly notes: string[];
  /** The directory each API create returned, keyed by the worktree name. */
  created: Record<string, string | undefined>;
  listStatus?: string;
  listOutput?: string;
  /** Inventory rows carrying either scenario name after the list round. */
  inventoryCowRows: ReadonlyArray<{ directory: string; strategy?: string }>;
}

/** The names the scenario creates and expects listed. */
const LIST_NAMES = ["lst-one", "lst-two"] as const;

export async function runListScenario(options: {
  readonly port: number;
}): Promise<ListScenarioResult> {
  const result: ListScenarioResult = { notes: [], created: {}, inventoryCowRows: [] };
  const config = await makeConfigRoot();
  config.env.OPENCODE_SIMULATE = "1";
  config.env.OPENCODE_DRIVE = "1";
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await mergeSimulationConfig(config.config, [{ package: pluginDir, options: {} }]);

  const source = join(config.root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "tracked.txt"), "list source\n");
  git(source, "init", "-q");
  git(source, "config", "user.email", "e2e@example.com");
  git(source, "config", "user.name", "e2e");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "list source");

  const { startServer } = await import("./server");
  const server = await startServer(config, { port: options.port, location: source });
  try {
    // Create both worktrees through the real HTTP API, the same shape fanOut
    // uses: the parent beside the source, so the reflink crosses no device.
    const parent = join(source, "..", "worktrees");
    for (const name of LIST_NAMES) {
      const created = await server.api.json("POST", "/api/worktree", {
        strategy: "cow",
        directory: parent,
        name,
      });
      const directory = (created.body as { directory?: string }).directory;
      result.created[name] = directory;
      result.notes.push(`create ${name} -> ${created.status} ${directory ?? created.text.slice(0, 120)}`);
    }

    // One scripted session: the real registry decodes `list_worktrees`, the
    // real tool execution reads the inventory and stats the directories.
    const endpoint = driveEndpoint(server);
    result.notes.push(`drive backend websocket: ${endpoint}`);
    const drive = await driveModel(endpoint, [
      // No resolveScriptedInput here: the tool takes no input, and its schema
      // rejects unknown properties such as an injected sourceDirectory.
      { kind: "tool-call", name: "list_worktrees", input: {} },
      { kind: "text", text: "done" },
    ]);
    const session = await server.api.json("POST", "/api/session", {
      title: "list",
      location: { directory: source },
      model: { providerID: "sim", id: "sim" },
    });
    const sessionID = (session.body as { data?: { id?: string } }).data?.id;
    result.notes.push(`session create -> ${session.status} ${sessionID ?? session.text.slice(0, 120)}`);

    const prompted = await server.api.json("POST", `/api/session/${sessionID}/prompt`, {
      text: "List the worktrees.",
      model: { providerID: "sim", id: "sim" },
    });
    result.notes.push(`prompt -> ${prompted.status}`);

    await Promise.race([drive.done, Bun.sleep(20_000).then(() => undefined)]);
    await Bun.sleep(750);
    const messages = await server.api.json("GET", `/api/session/${sessionID}/message`);
    const scripted = findScriptedTool(messages.body, "list_worktrees");
    drive.close();
    result.listStatus = scripted?.status;
    result.listOutput = scripted?.output;
    result.notes.push(
      `scripted list_worktrees -> ${scripted?.status ?? "not found"}` +
        `${scripted?.output ? `: ${scripted.output.slice(0, 200)}` : ""}`,
    );

    // The inventory facts the tool's answer must agree with.
    const rows = await inventoryRows(server);
    result.inventoryCowRows = rows.filter((entry) =>
      (LIST_NAMES as readonly string[]).includes(basename(entry.directory)),
    );
    result.notes.push(`inventory rows for the scenario names: ${JSON.stringify(result.inventoryCowRows)}`);
    return result;
  } finally {
    await server.stop();
    await removePath(config.root);
  }
}

// ---------------------------------------------------------------------------
// Post-create hooks (ticket 05)
//
// Two servers, each configured through its own plugin `options`: one whose
// hooks write a marker and the source path into the fresh clone, one whose
// only hook fails. The worktrees are created through the real HTTP API, so
// what runs is the strategy's create tail exactly as the API, TUI, and
// spawn_workspace entry paths all reach it.
// ---------------------------------------------------------------------------

export interface HooksScenarioResult {
  readonly notes: string[];
  /** The success server's source directory, for comparing the env injection. */
  source: string;
  /** The directory the hooked create returned. */
  createdDirectory?: string;
  /** The marker file a hook wrote inside the new worktree. */
  marker?: string;
  /** The source path a hook read from COW_SOURCE_DIRECTORY. */
  sourceEnv?: string;
  /** Inventory rows recorded for the hooked worktree after the create. */
  inventoryCowRows: number;
  failStatus?: number;
  failText?: string;
  /** True when the failed create left no directory behind. */
  orphanGone?: boolean;
}

const HOOKS_SOURCE_NAME = "hook-ok";

/**
 * Boots one throwaway server whose plugin options configure the given hooks,
 * with a committed source project beside the config root.
 */
async function bootHooksServer(options: {
  readonly port: number;
  readonly pluginOptions: Record<string, unknown>;
}): Promise<{
  config: Awaited<ReturnType<typeof makeConfigRoot>>;
  server: Server;
  source: string;
  parent: string;
}> {
  const config = await makeConfigRoot();
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await declarePlugin(config, pluginDir, options.pluginOptions);

  const source = join(config.root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "tracked.txt"), "hooks source\n");
  git(source, "init", "-q");
  git(source, "config", "user.email", "e2e@example.com");
  git(source, "config", "user.name", "e2e");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "hooks source");

  const { startServer } = await import("./server");
  const server = await startServer(config, { port: options.port, location: source });
  return { config, server, source, parent: join(source, "..", "worktrees") };
}

export async function runHooksScenario(scenario: {
  readonly port: number;
}): Promise<HooksScenarioResult> {
  const result: HooksScenarioResult = { notes: [], source: "", inventoryCowRows: 0 };

  // Round 1: hooks that succeed — a marker proves they ran, the env read
  // proves what they saw, and the inventory proves the create completed.
  const ok = await bootHooksServer({
    port: scenario.port,
    pluginOptions: {
      hooks: {
        postCreate: [
          'printf "hook-marker" > "$COW_WORKTREE_PATH/hooks-marker.txt"',
          'printf "%s" "$COW_SOURCE_DIRECTORY" > "$COW_WORKTREE_PATH/hooks-source.txt"',
        ],
      },
    },
  });
  try {
    const created = await ok.server.api.json("POST", "/api/worktree", {
      strategy: "cow",
      directory: ok.parent,
      name: HOOKS_SOURCE_NAME,
    });
    const directory = (created.body as { directory?: string }).directory;
    result.createdDirectory = directory;
    result.source = ok.source;
    result.notes.push(
      `hooks ok: POST /api/worktree -> ${created.status} ${directory ?? created.text.slice(0, 120)}`,
    );
    if (directory !== undefined) {
      result.marker = await readFile(join(directory, "hooks-marker.txt"), "utf8").catch(
        () => undefined,
      );
      result.sourceEnv = await readFile(join(directory, "hooks-source.txt"), "utf8").catch(
        () => undefined,
      );
    }
    result.inventoryCowRows = (await inventoryRows(ok.server)).filter(
      (entry) => basename(entry.directory) === HOOKS_SOURCE_NAME,
    ).length;
    result.notes.push(
      `hooks ok: marker=${JSON.stringify(result.marker)} ` +
        `sourceEnv matches source=${result.sourceEnv === ok.source} ` +
        `inventory rows=${result.inventoryCowRows}`,
    );
  } finally {
    await ok.server.stop();
    await removePath(ok.config.root);
  }

  // Round 2: a hook that fails must abort the create with no orphan clone.
  const bad = await bootHooksServer({
    port: scenario.port + 1,
    pluginOptions: { hooks: { postCreate: ['printf "about to fail"; exit 3'] } },
  });
  try {
    const failed = await bad.server.api.json("POST", "/api/worktree", {
      strategy: "cow",
      directory: bad.parent,
      name: "hook-bad",
    });
    result.failStatus = failed.status;
    result.failText = failed.text;
    result.orphanGone = !(await exists(join(bad.parent, "hook-bad")));
    result.notes.push(
      `hooks fail: POST /api/worktree -> ${failed.status} ${failed.text.slice(0, 240)}; ` +
        `orphan gone=${result.orphanGone}`,
    );
  } finally {
    await bad.server.stop();
    await removePath(bad.config.root);
  }
  return result;
}
