// Augmentations for opencode2 plugin API members that the running binary
// implements but the published @opencode-ai/plugin beta has not yet typed.
//
// The installed plugin package is the old v1 build: its `Context` is a v1
// `PluginInput` with no `worktree` domain and no `location`. An interface merge
// would collide with the v1 members' types, so the augmentation adds a *new*
// `Context` interface instead — exactly the v2 promise Context shape
// (packages/plugin/src/promise/plugin.ts), with the worktree and location
// domains filled in below. The running opencode2 binary (v2 HEAD) provides
// both, so the code runs today and type-checks once the package catches up.
//
// Remove this file when `ctx.worktree` and `ctx.location` appear in
// node_modules/@opencode-ai/plugin/dist/promise/plugin.d.ts.

declare module "@opencode-ai/plugin" {
  interface Context {
    readonly location: LocationInfo;
    readonly worktree: WorktreeDomain;
    readonly tool: ToolDomain;
    readonly session: SessionDomain;
    readonly options: Readonly<Record<string, unknown>>;
  }
}

export interface LocationInfo {
  readonly directory: string;
  readonly workspaceID?: string;
  readonly project: {
    readonly id: string;
    readonly directory: string;
    readonly canonical: string;
  };
}

/**
 * A session handle as `createSession` needs it. Only the fields this plugin
 * reads are typed; the v2 `SessionDomain` returns a much larger `Session.Info`.
 * Keep this structural so the real API satisfies it without importing the v2
 * client, which the installed package does not ship.
 */
export interface SessionInfo {
  readonly id: string;
}

/** The slice of the v2 `SessionDomain` this plugin uses. */
export interface SessionDomain {
  readonly create: (input: {
    readonly title?: string;
    readonly location: { readonly directory: string };
  }) => Promise<SessionInfo>;
}

/** The slice of the v2 `WorktreeApi` this plugin uses, folded into WorktreeDomain below. */

/** A tool registered through the v2 `ToolEditor`. */
export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  /**
   * The declared output schema. A tool that returns an `output` field must
   * declare it; opencode2 dies on an undeclared output rather than treating it
   * as a recoverable error.
   */
  readonly output?: unknown;
  /**
   * `Tool.Options` (packages/schema/src/tool.ts). `codemode: false` keeps the
   * tool on the provider's native tool list; the default routes it through
   * CodeMode, where the model only sees `execute`.
   */
  readonly options?: { readonly codemode?: boolean } & Readonly<Record<string, unknown>>;
  readonly execute: (input: any, context: unknown) => Promise<ToolResult>;
}

export interface ToolResult {
  readonly output?: unknown;
  readonly content?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolEditor {
  add(tool: ToolInfo): void;
}

export interface ToolDomain {
  readonly transform: (
    callback: (editor: ToolEditor) => void,
  ) => Promise<{ dispose(): Promise<void> }>;
}

export interface WorktreeCreateInput {
  readonly sourceDirectory: string;
  readonly directory: string;
  readonly branch?: string;
}

export interface WorktreeRemoveInput {
  readonly directory: string;
  readonly force: boolean;
}

export interface WorktreeEntry {
  readonly directory: string;
  readonly type: "root" | "worktree";
}

/**
 * A worktree inventory entry as `ctx.worktree.list()` returns it — upstream's
 * `Worktree.Info` (packages/schema/src/worktree.ts): the directory and the id
 * of the strategy that produced it. The checkout root is listed with no
 * strategy. Verified against upstream 2.0.2 (`packages/core/src/worktree.ts`
 * `ops.list`, served by `GET /api/worktree`).
 */
export interface WorktreeInventoryEntry {
  readonly directory: string;
  readonly strategy?: string;
}

export interface WorktreeResult {
  readonly directory: string;
}

export interface WorktreeDefinition {
  readonly id: string;
  readonly create: (
    input: WorktreeCreateInput,
    context: { readonly signal: AbortSignal },
  ) => Promise<WorktreeResult>;
  readonly remove: (
    input: WorktreeRemoveInput,
    context: { readonly signal: AbortSignal },
  ) => Promise<void>;
  readonly list: (
    sourceDirectory: string,
    context: { readonly signal: AbortSignal },
  ) => Promise<readonly WorktreeEntry[]>;
}

export interface WorktreeEditor {
  /** Registers an implementation and selects it as the default. */
  add(definition: WorktreeDefinition): void;
}

export interface WorktreeDomain {
  readonly create: (input: {
    readonly strategy?: string;
    readonly name?: string;
    readonly location?: { readonly directory?: string };
    /**
     * `Worktree.CreateInput.directory` — the **parent** directory for the new
     * worktree, not the worktree path. opencode2 appends the name. Unset
     * defaults to the server's data directory.
     *
     * Assembly contract (pinned upstream fact): opencode2 assembles the
     * worktree directory as `<parent>/<name>` verbatim — no sanitization, no
     * suffixing. Both halves of `spawn_workspace` rely on this: the create
     * flow hands over exactly this parent (`predictedParent` in src/tool.ts),
     * and attach predicts `<parent>/<name>` as the path an earlier create
     * under the same input would have produced.
     */
    readonly directory?: string;
  }) => Promise<WorktreeResult>;
  readonly remove: (input: {
    readonly directory: string;
    readonly force: boolean;
  }) => Promise<void>;
  /**
   * The Worktree inventory for the current location — one
   * `WorktreeInventoryEntry` per directory opencode2 has a record of. Verified
   * against upstream 2.0.2 (`ops.list`): a bare call is answered with the
   * location's entries. The listing reconciles as it reads — rows whose
   * directory no longer exists are pruned — so an entry here means the
   * directory is really there.
   */
  readonly list: (input?: {
    readonly location?: { readonly directory?: string };
  }) => Promise<readonly WorktreeInventoryEntry[]>;
  readonly transform: (
    callback: (editor: WorktreeEditor) => void,
  ) => Promise<{ dispose(): Promise<void> }>;
}