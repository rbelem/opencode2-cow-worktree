#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * e2e dogfood harness for opencode2-cow-worktree (issue #8).
 *
 * Starts a real `opencode2 serve` against a throwaway config root, installs the
 * plugin by directory, activates it, then fans out worktrees through the real
 * HTTP API and proves the produced directories are independent Deep clones.
 *
 * Run: `bun scripts/e2e/harness.ts [--keep]`
 *
 * The harness never touches the user's real opencode2 config: every XDG path
 * and the config dir point inside a fresh temp root, and everything is removed
 * on exit unless `--keep` is passed.
 */
import { execFileSync } from "node:child_process";
import { pluginLogLines, startServer, type Server } from "./server";
import { Assertions } from "./assertions";
import { join } from "node:path";
import {
  assertDeepClones,
  assertInventory,
  fanOut,
  proveIndependence,
  removeWorktrees,
  runFallbackScenarios,
  runNonCowServer,
  type WorktreeRun,
} from "./scenarios";
import { writeRunLog } from "./runlog";
import { makeConfigRoot, makeSourceProject, installPlugin, declarePlugin, removePath } from "./lib";

const FANOUT = Number(process.env.E2E_FANOUT ?? 3);
const PORT = Number(process.env.E2E_PORT ?? 45980);
const keep = process.argv.includes("--keep");

function log(message: string): void {
  console.log(message);
}

async function main(): Promise<number> {
  const config = await makeConfigRoot();
  const pluginDir = await installPlugin(join(config.root, "plugin"));
  await declarePlugin(config, pluginDir);
  const source = config.project;
  await makeSourceProject(source);

  const assertions = new Assertions();
  let server: Server | undefined;
  try {
    server = await startServer(config, { port: PORT, location: source });
    const runtime = detectRuntime(server);
    log(`server up at ${server.url} (runtime: ${runtime})`);

    const runs: WorktreeRun[] = await fanOut(server, source, assertions, FANOUT);
    await proveIndependence(assertions, source, runs);
    await assertDeepClones(assertions, source, runs);
    await assertInventory(assertions, server, runs);
    const fallback = await runFallbackScenarios(server, config, assertions);
    await removeWorktrees(assertions, server, runs);

    // §6 fallback on a real non-CoW filesystem. `POST /api/worktree` invokes
    // the strategy directly, so the fallback tool is not reached here; this
    // proves the strategy's fail-loud contract on tmpfs instead.
    const nonCow = await runNonCowServer({ port: PORT + 1, fallback: "none" });
    assertions.check(
      "non-CoW + strategy cow: create fails (strategy fail-loud)",
      (nonCow.disabledStatus ?? 0) >= 400,
      `${nonCow.disabledStatus} ${nonCow.disabledText}`,
    );
    assertions.check(
      "non-CoW + strategy cow: error names the unsupported condition",
      /not supported|copy-on-write|CoW|fallback|failed to clone/i.test(nonCow.disabledText ?? ""),
      (nonCow.disabledText ?? "").slice(0, 200),
    );
    assertions.check(
      "non-CoW + strategy cow: no directory left behind",
      nonCow.enabledMechanism === undefined,
      String(nonCow.enabledMechanism),
    );
    const nonCowOptIn = await runNonCowServer({ port: PORT + 2, fallback: "git" });
    assertions.check(
      "non-CoW + plugin fallback git: API create still selects cow (fallback is tool-only)",
      (nonCowOptIn.enabledStatus ?? 0) >= 400,
      `${nonCowOptIn.enabledStatus} ${nonCowOptIn.enabledText}`,
    );
    fallback.notes.push(...nonCow.notes, ...nonCowOptIn.notes);

    await writeRunLog({ config, source, server, runtime, runs, assertions, fallback, version: serverVersion() });

    log("");
    for (const check of assertions.checks) log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
    log("");
    log(`${assertions.checks.length} checks, ${assertions.failed.length} failed`);
    return assertions.failed.length === 0 ? 0 : 1;
  } catch (error) {
    if (server) {
      log("--- server output (last plugin/worktree lines) ---");
      for (const line of pluginLogLines(server)) log(line);
    }
    throw error;
  } finally {
    await server?.stop();
    if (!keep) await removePath(config.root);
    else log(`kept temp root: ${config.root}`);
  }
}

/** The server is a Bun single-file build; record that, do not assume it. */
function detectRuntime(server: Server): string {
  const match = server.output().match(/Bun v([0-9.]+)/);
  if (match) return `bun ${match[1]}`;
  // The serve path does not print its runtime banner; the binary is a Bun
  // single-file build (verified by `strings`), so state that with the evidence.
  return "bun (single-file build; no runtime banner printed)";
}

function serverVersion(): string {
  try {
    return execFileSync("opencode2", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

await main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
