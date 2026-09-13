import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CowCapability } from "./capability";
import type { Mechanism } from "./mechanism";
import type { WorktreeInventoryEntry } from "../types/opencode2-worktree";

/** What a successful `spawnWorkspace` produced. */
export interface SpawnWorkspaceResult {
  readonly sessionID: string;
  readonly directory: string;
  readonly mechanism: Mechanism;
  /**
   * True when the session was attached to an already-existing Worktree instead
   * of a fresh clone. Absent for a created Worktree: the field's presence is
   * the attach marker, and `mechanism` then reports the mechanism of the
   * directory that was found, not of a clone this call performed.
   */
  readonly attached?: boolean;
}

/** Whether a caller who asked for a CoW clone may be given a Shallow worktree. */
export type FallbackPolicy = "none" | "git";

/**
 * The seams `spawnWorkspace` drives. Each is injected so the decision table is
 * testable without opencode2, and so the fallback ticket (#6) can supply the
 * git strategy and its own config-derived policy without touching this file.
 */
export interface SpawnWorkspaceDeps {
  /** Answers the CoW capability question for a directory. */
  readonly probe: (directory: string) => Promise<CowCapability>;
  /**
   * Reports the device a path's filesystem belongs to, or `undefined` when it
   * cannot be read. Injected so a cross-device target is testable without a
   * second mount.
   */
  readonly probeDevice: (path: string) => Promise<number | undefined>;
  /**
   * Creates a Worktree with the named Strategy, returning its directory.
   * `parentDirectory` is opencode2's `Worktree.CreateInput.directory`: the
   * **parent** the worktree is created under, not the worktree path itself.
   * opencode2 appends the name, so it is what decides the target device.
   */
  readonly createWorktree: (input: {
    readonly sourceDirectory: string;
    readonly parentDirectory: string;
    readonly strategy: Mechanism;
    readonly name?: string;
  }) => Promise<{ readonly directory: string }>;
  /** Starts a session whose Location is the directory; returns its id. */
  readonly createSession: (directory: string, name?: string) => Promise<string>;
  /** Removes a Worktree this call created. Used only to clean up a failure. */
  readonly removeWorktree: (directory: string) => Promise<void>;
  /**
   * Lists the Worktree inventory opencode2 records for the caller's location —
   * one `{ directory, strategy? }` entry per Worktree (`ctx.worktree.list()`).
   * Attach reads it to decide whether an existing directory is ours (ADR 0003:
   * the inventory, not a plugin-owned registry, is the source of truth).
   * Injected so the decision is testable without opencode2.
   */
  readonly listWorktrees: () => Promise<readonly WorktreeInventoryEntry[]>;
  /**
   * Whether a path exists and is a directory. Attach consults it twice: the
   * predicted target must already exist before any attach question is asked,
   * and the Deep-clone signature is `<target>/.git` being a *directory*. Used
   * for no other purpose. Injected like `deviceOf` so both checks are testable
   * without a filesystem.
   */
  readonly isDirectory: (path: string) => Promise<boolean>;
  /** Defaults to `"none"`: a request for `cow` is a statement about what you get. */
  readonly fallback?: FallbackPolicy;
  /** Worktree parent. Defaults to a same-filesystem sibling of the source. */
  readonly targetRoot?: string;
}

export interface SpawnWorkspaceInput {
  readonly sourceDirectory: string;
  readonly name?: string;
}

/**
 * Creates one Worktree and starts a session in it, reporting the Mechanism that
 * produced the directory.
 *
 * The CoW capability predicate is consulted on the source directory and decides
 * the strategy. A capability *error* (missing path, permissions, I/O) always
 * fails, even with fallback enabled: it is not the same answer as "not
 * supported", and honouring the fallback there would hide a real problem behind
 * a git worktree. The fallback only applies to a genuine negative.
 *
 * A CoW clone cannot cross a filesystem boundary, so the tool creates the
 * Worktree under a parent on the source's own device — a sibling by default, or
 * the configured target root. When the chosen parent is on a different device
 * the call fails with an explicit device-mismatch error rather than letting a
 * bare `EXDEV` surface as an unexplained clone failure.
 *
 * There is no silent fallback by default. If the probe says unsupported and no
 * fallback is configured, the call throws rather than fabricating a mechanism —
 * the result type has no "none", and a caller must never be told it got a Deep
 * clone it did not get.
 *
 * If the Worktree is created but the session cannot be started, the Worktree is
 * removed before the error propagates, so no directory is orphaned. If creating
 * the Worktree itself fails there is nothing to clean up.
 *
 * Attach: when the call names a Worktree (`name`) whose predicted directory
 * already exists, the call attaches instead of cloning. The prediction is
 * assembled exactly as the create flow assembles it — the same parent, the
 * same name — and the existing directory is attached to only when the
 * inventory records it with `strategy: "cow"` (ADR 0003) **and** it carries the
 * Deep-clone signature (`.git` is a directory). Every other occupant of the
 * predicted path — a `git`-strategy Worktree, a path the inventory does not
 * know (a Foreign worktree), a `cow` row that lost its Deep-clone shape — is
 * refused loudly before any session is started and without touching the
 * filesystem. Attach never consults the capability probe (no clone is
 * attempted) and never removes the existing directory when its own session
 * start fails, because the directory predates the call.
 */
export async function spawnWorkspace(
  input: SpawnWorkspaceInput,
  deps: SpawnWorkspaceDeps,
): Promise<SpawnWorkspaceResult> {
  const name = input.name;
  // A present, non-empty name may hit an existing Worktree; an empty string is
  // not a name and takes the create path exactly as before.
  if (name) {
    const attached = await tryAttach(name, input.sourceDirectory, deps);
    if (attached !== undefined) return attached;
  }
  const capability = await deps.probe(input.sourceDirectory);
  if (capability.status === "error") {
    throw new Error(
      `cannot clone ${input.sourceDirectory}: CoW capability probe failed`,
      { cause: capability.error },
    );
  }

  const mechanism: Mechanism =
    capability.status === "supported"
      ? "cow"
      : selectFallback(deps.fallback ?? "none", input.sourceDirectory);

  const parent = deps.targetRoot ?? join(input.sourceDirectory, "..");
  await verifySameDevice(input.sourceDirectory, parent, mechanism, deps.probeDevice);

  const worktree = await deps.createWorktree({
    sourceDirectory: input.sourceDirectory,
    parentDirectory: parent,
    strategy: mechanism,
    name: input.name,
  });

  try {
    const sessionID = await deps.createSession(worktree.directory, input.name);
    return { sessionID, directory: worktree.directory, mechanism };
  } catch (cause) {
    // The cleanup is best-effort: it must never replace the failure that
    // triggered it. `removeWorktree` goes through opencode2's DELETE route,
    // which refuses once the directory is already gone, so a successful
    // session-create failure would otherwise surface as a confusing
    // "directory unavailable" instead of the original cause.
    try {
      await deps.removeWorktree(worktree.directory);
    } catch {
      // Leave the tree for the caller to inspect; the real error follows.
    }
    throw new Error(`session start failed in ${worktree.directory}`, { cause });
  }
}

/**
 * Rejects a `cow` parent on a different filesystem than the source before the
 * create is attempted. A reflink cannot cross devices, so this is a distinct,
 * actionable failure and must not surface as a generic clone error. The `git`
 * mechanism does not share extents and is left untouched.
 *
 * An unreadable device on either side is not a mismatch — `probeDevice` returns
 * `undefined` rather than throwing, and the create proceeds to report whatever
 * the filesystem actually does.
 */
async function verifySameDevice(
  source: string,
  parent: string,
  mechanism: Mechanism,
  probeDevice: SpawnWorkspaceDeps["probeDevice"],
): Promise<void> {
  if (mechanism !== "cow") return;
  // A parent that does not exist yet (an injected fake in the unit tests, or a
  // target root opencode2 has not created) is checked as-is: `probeDevice`
  // returns `undefined` and the create proceeds rather than failing on an
  // unreadable device. The strategy owns the nearest-ancestor walk, where the
  // target is a full path opencode2 assembled.
  await verifyCowSameDevice({ source, target: parent, probeDevice });
}

function selectFallback(policy: FallbackPolicy, sourceDirectory: string): Mechanism {
  if (policy === "git") return "git";
  throw new Error(
    `copy-on-write is not supported for ${sourceDirectory} and no fallback is enabled`,
  );
}

/**
 * The device a path's filesystem belongs to, or `undefined` when it cannot be
 * read (a path that does not exist yet, or a permission failure).
 */
export async function deviceOf(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.dev;
  } catch {
    return undefined;
  }
}

/**
 * The actionable `cow` failure for a clone whose target sits on a different
 * filesystem than its source. A reflink cannot cross a device boundary, so the
 * remedy is always to move the target — never to fall back silently.
 *
 * Shared by the tool's pre-create guard and the strategy's own pre-flight so
 * the two name the same cause and the same fix.
 */
export function crossDeviceError(source: string, target: string): Error {
  return new Error(
    `cow cannot clone ${source} into ${target}: the target is on a different ` +
      "filesystem and a reflink cannot cross devices. Point opencode2's " +
      "`worktree.directory` config (or the spawn_workspace `targetRoot` option) " +
      "at a directory on the source's filesystem.",
  );
}

/**
 * Rejects a `cow` clone whose target device differs from the source's. Throws
 * before any directory is created; an unreadable device on either side is not a
 * mismatch, so an unknown device proceeds rather than fabricating a failure.
 *
 * The caller passes a path whose device decides the clone: the tool's worktree
 * **parent** (opencode2 appends the name under it) or the strategy's resolved
 * target parent. The strategy resolves a not-yet-created target to its nearest
 * existing ancestor first, then calls `assertSameDevice`.
 */
export async function verifyCowSameDevice(input: {
  readonly source: string;
  readonly target: string;
  readonly probeDevice: (path: string) => Promise<number | undefined>;
}): Promise<void> {
  const [sourceDevice, targetDevice] = await Promise.all([
    input.probeDevice(input.source),
    input.probeDevice(input.target),
  ]);
  assertSameDevice(input.source, sourceDevice, input.target, targetDevice);
}

/**
 * The one cross-device rule: a `cow` clone may cross no device boundary.
 * `undefined` on either side is unknown, not a mismatch.
 */
export function assertSameDevice(
  source: string,
  sourceDevice: number | undefined,
  target: string,
  targetDevice: number | undefined,
): void {
  if (
    sourceDevice === undefined ||
    targetDevice === undefined ||
    sourceDevice === targetDevice
  ) {
    return;
  }
  throw crossDeviceError(source, target);
}

/**
 * Resolves a target that may not exist yet to the first ancestor whose device
 * can be read, so the strategy's pre-flight checks the filesystem the target
 * will actually land on. The root's parent is itself, so the walk terminates;
 * a fully unreadable chain returns `undefined` and the pre-flight proceeds.
 */
export async function nearestExistingDevice(
  path: string,
  probeDevice: (path: string) => Promise<number | undefined>,
): Promise<number | undefined> {
  let current = path;
  for (;;) {
    const device = await probeDevice(current);
    if (device !== undefined) return device;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Whether a path exists and is a directory. The live binding for the tool's
 * `isDirectory` seam, alongside `deviceOf`: a path occupied by a file and a
 * path that is not there at all are the same answer — no existing Worktree.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The attach half of a named `spawnWorkspace`: when the predicted directory
 * already exists, decide whether the call may attach to it. Returns `undefined`
 * when the predicted path is free, handing control back to the create flow
 * unchanged.
 *
 * The prediction reuses the create flow's parent — the configured target root,
 * or a sibling of the source — so a path that exists here is exactly a path
 * `createWorktree` would collide with. The check runs before the capability
 * probe on purpose: attach attempts no clone, so the source's CoW capability
 * is not its question to ask.
 */
async function tryAttach(
  name: string,
  sourceDirectory: string,
  deps: SpawnWorkspaceDeps,
): Promise<SpawnWorkspaceResult | undefined> {
  const parent = deps.targetRoot ?? join(sourceDirectory, "..");
  const target = join(parent, name);
  if (!(await deps.isDirectory(target))) return undefined;
  return attachToExisting(name, target, deps);
}

/**
 * The attach decision for a path that already exists. The inventory is the
 * source of truth for "ours" (ADR 0003): an entry recorded with `cow` plus the
 * Deep-clone signature (`.git` is a directory) means the `cow` strategy
 * materialized this directory, so a new session may bind to it. Every other
 * answer is refused loudly — before any session is created and with no
 * filesystem change — because a Foreign worktree, another strategy's Worktree,
 * or a `cow` row that lost its Deep-clone shape is not this tool's to attach
 * to.
 */
async function attachToExisting(
  name: string,
  target: string,
  deps: SpawnWorkspaceDeps,
): Promise<SpawnWorkspaceResult> {
  const entry = await inventoryEntryFor(deps, target);
  if (entry === undefined) throw foreignWorktreeError(target);
  if (entry.strategy !== "cow") {
    throw foreignStrategyError(target, entry.strategy);
  }
  if (!(await deps.isDirectory(join(target, ".git")))) {
    throw notDeepCloneError(target);
  }
  try {
    const sessionID = await deps.createSession(target, name);
    return { sessionID, directory: target, mechanism: "cow", attached: true };
  } catch (cause) {
    // No removeWorktree here, unlike the create flow: the directory existed
    // before this call, so a failed session start must leave it untouched.
    throw new Error(`session start failed in existing worktree ${target}`, { cause });
  }
}

/** The inventory entry recorded for a directory, when the inventory knows it. */
async function inventoryEntryFor(
  deps: SpawnWorkspaceDeps,
  directory: string,
): Promise<WorktreeInventoryEntry | undefined> {
  const entries = await deps.listWorktrees();
  return entries.find((candidate) => candidate.directory === directory);
}

/** The refusal for a path the worktree inventory does not know at all. */
function foreignWorktreeError(target: string): Error {
  return new Error(
    `refusing to attach to ${target}: the path exists but opencode2's worktree ` +
      "inventory has no entry for it, so it is not a worktree this strategy " +
      "materialized (a Foreign worktree). spawn_workspace attaches only to " +
      "worktrees its cow strategy created; pick another name or remove the " +
      "directory.",
  );
}

/** The refusal for an inventory entry naming a strategy other than `cow`. */
function foreignStrategyError(target: string, strategy: string | undefined): Error {
  return new Error(
    `refusing to attach to ${target}: the worktree inventory records it with ` +
      `${describeStrategy(strategy)}, not "cow" — spawn_workspace will not attach ` +
      "to a Worktree another strategy materialized. Remove it through opencode2 " +
      "or pick another name.",
  );
}

/**
 * The refusal for a `cow` inventory row whose `.git` is not a directory: whatever
 * sits at the path now, it is not the Deep clone this strategy's create leaves
 * behind, so the row is stale or the directory was replaced.
 */
function notDeepCloneError(target: string): Error {
  return new Error(
    `refusing to attach to ${target}: the worktree inventory records strategy ` +
      `"cow", but ${join(target, ".git")} is not a directory, so the directory does ` +
      "not have the Deep-clone signature a cow worktree is created with. Refresh " +
      "the inventory or remove the directory.",
  );
}

/** The strategy as a refusal names it; the checkout root is listed with none. */
function describeStrategy(strategy: string | undefined): string {
  return strategy === undefined ? "no strategy" : `"${strategy}"`;
}
