import type { CowCapability } from "./capability";
import type { Mechanism } from "./mechanism";

/** What a successful `spawnWorkspace` produced. */
export interface SpawnWorkspaceResult {
  readonly sessionID: string;
  readonly directory: string;
  readonly mechanism: Mechanism;
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
  /** Creates a Worktree with the named Strategy, returning its directory. */
  readonly createWorktree: (input: {
    readonly sourceDirectory: string;
    readonly strategy: Mechanism;
    readonly name?: string;
  }) => Promise<{ readonly directory: string }>;
  /** Starts a session whose Location is the directory; returns its id. */
  readonly createSession: (directory: string, name?: string) => Promise<string>;
  /** Removes a Worktree this call created. Used only to clean up a failure. */
  readonly removeWorktree: (directory: string) => Promise<void>;
  /** Defaults to `"none"`: a request for `cow` is a statement about what you get. */
  readonly fallback?: FallbackPolicy;
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
 * There is no silent fallback by default. If the probe says unsupported and no
 * fallback is configured, the call throws rather than fabricating a mechanism —
 * the result type has no "none", and a caller must never be told it got a Deep
 * clone it did not get.
 *
 * If the Worktree is created but the session cannot be started, the Worktree is
 * removed before the error propagates, so no directory is orphaned. If creating
 * the Worktree itself fails there is nothing to clean up.
 */
export async function spawnWorkspace(
  input: SpawnWorkspaceInput,
  deps: SpawnWorkspaceDeps,
): Promise<SpawnWorkspaceResult> {
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

  const worktree = await deps.createWorktree({
    sourceDirectory: input.sourceDirectory,
    strategy: mechanism,
    name: input.name,
  });

  try {
    const sessionID = await deps.createSession(worktree.directory, input.name);
    return { sessionID, directory: worktree.directory, mechanism };
  } catch (cause) {
    await deps.removeWorktree(worktree.directory);
    throw new Error(`session start failed in ${worktree.directory}`, { cause });
  }
}

function selectFallback(policy: FallbackPolicy, sourceDirectory: string): Mechanism {
  if (policy === "git") return "git";
  throw new Error(
    `copy-on-write is not supported for ${sourceDirectory} and no fallback is enabled`,
  );
}
