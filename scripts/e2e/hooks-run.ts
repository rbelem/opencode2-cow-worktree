#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * Runs only the ticket-05 post-create hooks scenario, without the full harness.
 *
 * `bun scripts/e2e/hooks-run.ts` — boots two simulated servers, creates a
 * worktree through the real HTTP API on each, prints the observed facts, and
 * tears down. This is the evidence that the `hooks.postCreate` option runs at
 * the end of the strategy's create flow:
 *
 *   1. hooks that succeed write a marker into the fresh clone and read the
 *      absolute source directory from `COW_SOURCE_DIRECTORY`;
 *   2. a hook that fails makes the create fail, names the hook and its step,
 *      and leaves no orphan directory behind.
 *
 * `bun scripts/e2e/harness.ts` remains the canonical, committed run; this is
 * the focused entry point for the hooks path alone.
 */
import { runHooksScenario } from "./simulation";

const PORT = Number(process.env.E2E_PORT ?? 46200);

const hooks = await runHooksScenario({ port: PORT });
for (const note of hooks.notes) console.log(note);

const ok =
  hooks.createdDirectory !== undefined &&
  hooks.marker === "hook-marker" &&
  hooks.sourceEnv === hooks.source &&
  hooks.inventoryCowRows === 1 &&
  (hooks.failStatus ?? 0) >= 400 &&
  /post-create hook failed \(step 1 of 1\)/.test(hooks.failText ?? "") &&
  /exit code 3/.test(hooks.failText ?? "") &&
  hooks.orphanGone === true;

console.log(`hooks scenario passed: ${ok}`);
process.exit(ok ? 0 : 1);
