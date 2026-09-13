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
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { driveModel, type DriveController } from "./drive";
import { installPlugin, makeConfigRoot, removePath, git } from "./lib";
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
// Attach (issue #1)
//
// Two real sessions invoke `spawn_workspace` with the same name against ONE
// server. The first must create the worktree; the second must attach to it —
// the tool's own text says so, and the inventory must still list exactly one
// directory for that name. Everything below the drive controller is production
// code: the session loop, the tool registry, the plugin's tool execution, and
// opencode2's real worktree inventory.
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
}

/** The scripted name both rounds ask for. */
const ATTACH_NAME = "att";

/**
 * The attach scenario: one server, two scripted `spawn_workspace` calls with
 * the same name, one inventory.
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

    // Round 1: the named worktree does not exist yet, so the tool creates it.
    const first = await runScriptedRound({ server, endpoint, source, round: 1, notes: result.notes });
    result.firstStatus = first.status;
    result.firstOutput = first.output;
    const rows = await inventoryRows(server);
    result.notes.push(`inventory after round 1: ${JSON.stringify(rows)}`);
    result.worktreeDirectory = rows.find(
      (entry) => basename(entry.directory) === ATTACH_NAME,
    )?.directory;

    // Round 2: the same name. The tool must attach — its text says so — and
    // the inventory must not grow a second row for the name.
    const second = await runScriptedRound({ server, endpoint, source, round: 2, notes: result.notes });
    result.secondStatus = second.status;
    result.secondOutput = second.output;
    result.inventoryCount = (await inventoryRows(server)).filter(
      (entry) => basename(entry.directory) === ATTACH_NAME,
    ).length;
    result.notes.push(`inventory after round 2: ${result.inventoryCount} row(s) named "${ATTACH_NAME}"`);
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
  readonly notes: string[];
}): Promise<{ status?: string; output?: string }> {
  const drive = await driveModel(args.endpoint, [
    {
      kind: "tool-call",
      name: "spawn_workspace",
      input: resolveScriptedInput({ name: ATTACH_NAME }, args.source),
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
