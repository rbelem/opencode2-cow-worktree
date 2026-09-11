#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * Runs only the issue-#9 simulation scenario, without the full harness.
 *
 * `bun scripts/e2e/simulation-run.ts` — boots simulated servers, drives real
 * sessions with scripted tool calls, prints the observed facts, and tears down.
 * This is the evidence that `spawn_workspace` is reachable through a real
 * session and that the fallback policy holds end to end:
 *
 *   1. a builtin tool (`shell`) executes in the server process;
 *   2. `spawn_workspace` is offered to the model by name and completes on a CoW
 *      source with the `cow` mechanism;
 *   3. on a non-CoW source with `fallback: "git"` it completes and reports the
 *      `git` mechanism;
 *   4. on the same source with `fallback: "none"` it fails loudly.
 *
 * `bun scripts/e2e/harness.ts` remains the canonical, committed run; this is the
 * focused entry point for the simulation path alone.
 */
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runSimulationScenario } from "./simulation";

const PORT = Number(process.env.E2E_PORT ?? 45980) + 10;

const builtin = await runSimulationScenario({
  port: PORT,
  fallback: "git",
  scriptedTool: { name: "shell", input: { command: "echo sim-shell-ran" } },
});
console.log("--- scripted builtin tool ---");
console.log(`drive endpoint: ${builtin.driveEndpoint ?? "unknown"}`);
console.log(`tool count: ${builtin.toolNames.length}`);
console.log(`spawn_workspace offered: ${builtin.pluginToolOffered}`);
console.log(`scripted shell -> ${builtin.scriptedToolStatus}: ${builtin.scriptedToolOutput ?? ""}`);

const plugin = await runSimulationScenario({
  port: PORT + 1,
  fallback: "git",
  scriptedTool: { name: "spawn_workspace", input: { name: "sim" } },
});
console.log("--- scripted plugin tool (CoW source) ---");
console.log(`spawn_workspace offered: ${plugin.pluginToolOffered}`);
console.log(`scripted spawn_workspace -> ${plugin.scriptedToolStatus}`);

// Each scenario needs its own non-CoW root: the scenario creates and commits
// its source repo, so reusing one root would collide on the second run.
const nonCowFallback = await mkdtemp(join("/dev/shm", "cow-sim-fb-"));
const fallbackGit = await runSimulationScenario({
  port: PORT + 2,
  fallback: "git",
  sourceRoot: nonCowFallback,
  scriptedTool: { name: "spawn_workspace", input: { name: "fb" } },
});
console.log("--- scripted plugin tool (non-CoW source, fallback git) ---");
console.log(`offered: ${fallbackGit.pluginToolOffered}`);
console.log(`result: ${fallbackGit.scriptedToolStatus}`);

const nonCowNone = await mkdtemp(join("/dev/shm", "cow-sim-fl-"));
const fallbackNone = await runSimulationScenario({
  port: PORT + 3,
  fallback: "none",
  sourceRoot: nonCowNone,
  scriptedTool: { name: "spawn_workspace", input: { name: "fl" } },
});
console.log("--- scripted plugin tool (non-CoW source, fallback none) ---");
console.log(`offered: ${fallbackNone.pluginToolOffered}`);
console.log(`result: ${fallbackNone.scriptedToolStatus}`);

const builtinOk = builtin.scriptedToolStatus === "completed" &&
  (builtin.scriptedToolOutput ?? "").includes("sim-shell-ran");
// Offered by name and completed through the real session loop.
const pluginOk = plugin.pluginToolOffered === true && plugin.scriptedToolStatus === "completed";
// The fallback produced a git worktree and said so in the tool result.
const fallbackOk = fallbackGit.scriptedToolStatus === "completed" &&
  (fallbackGit.scriptedToolOutput ?? "").includes("git");
const failLoudOk = (fallbackNone.scriptedToolStatus ?? "").includes("not supported") &&
  (fallbackNone.scriptedToolStatus ?? "").includes("no fallback");

console.log(`builtin tool really executed: ${builtinOk}`);
console.log(`plugin tool offered and executed: ${pluginOk}`);
console.log(`non-CoW + fallback git produced a git worktree: ${fallbackOk}`);
console.log(`non-CoW + fallback none failed loudly: ${failLoudOk}`);

process.exit(builtinOk && pluginOk && fallbackOk && failLoudOk ? 0 : 1);

