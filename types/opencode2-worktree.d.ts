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

/**
 * The slice of a session record the occupancy guard reads back from
 * `ctx.session.get`. Verified against opencode2 0.0.0-next-20260912.3: the
 * record carries `time.created`/`time.updated` in epoch milliseconds and no
 * status field — sessions persist after completion, so last-activity time is
 * the only liveness signal a probe gets. Kept structural like `SessionInfo`;
 * the classifier treats odd shapes and throws as answers at runtime.
 */
export interface SessionGetResult {
  readonly id: string;
  readonly time?: { readonly updated?: number };
}

/** The slice of the v2 `SessionDomain` this plugin uses. */
export interface SessionDomain {
  readonly create: (input: {
    readonly title?: string;
    readonly location: { readonly directory: string };
  }) => Promise<SessionInfo>;
  /**
   * Reads one session by id. Verified against the running v2 binary
   * (0.0.0-next-20260912.3): the argument is `{ sessionID }` — a bare string
   * fails the input schema with `SchemaError: Expected object` — and an absent
   * id throws with `_tag: "Session.NotFoundError"` (the HTTP payload spells
   * the same 404 `SessionNotFoundError`). The promise is declared total
   * because the occupancy guard's classifier (`probeOccupyingSession` in
   * src/occupancy.ts) treats every throw and every odd shape as its answer.
   */
  readonly get: (input: {
    readonly sessionID: string;
  }) => Promise<SessionGetResult>;
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
 * `Worktree.Directory` (packages/schema/src/worktree.ts): the directory and the
 * id of the strategy that produced it. The checkout root is listed with no
 * strategy. Verified against 0.0.0-next-20260917 (`GET /api/worktree`
 * with `projectID`).
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
  /** Registers an implementation and selects it as the default. Later active registrations win. */
  add(definition: WorktreeDefinition): void;
}

export interface WorktreeDomain {
  readonly create: (input: {
    /**
     * The project the worktree belongs to. Required by the projectID-era API
     * (20260915 nightlies onward); `ctx.location.project.id` is the value.
     * Verified against 0.0.0-next-20260917
     * (packages/protocol/src/groups/worktree.ts).
     */
    readonly projectID: string;
    /**
     * The source directory to clone. Optional upstream (it defaults to the
     * project's canonical checkout and must be a registered row of the
     * project); passed explicitly so a session running inside a cow worktree
     * spawns from the directory it actually lives in.
     */
    readonly from?: string;
    readonly branch?: string;
    /**
     * Parent directory for the new worktree. opencode2 appends the name.
     *
     * Assembly contract (verified against 0.0.0-next-20260917): when the
     * assembled `<parent>/<name>` already exists, the server suffixes
     * `name-2` … `name-10` and fails with `DestinationExistsError` after
     * that — no longer the verbatim assembly of the 2.0.2-era binary.
     * `spawn_workspace` predicts the verbatim path and refuses anything there
     * it cannot attach to before create runs, so the suffix path is only
     * reachable for unnamed creates, whose names are server-generated slugs.
     */
    readonly directory?: string;
    readonly name?: string;
    /**
     * Requested strategy id. The projectID-era schema dropped the field and
     * ignores excess keys, so a create always uses the selected strategy —
     * the last active registration wins. The 2.0.2-era API honors the field,
     * which is how the tool's opt-in `git` fallback selects its mechanism
     * there; on projectID-era binaries the fallback cannot be requested and
     * a non-CoW source fails loudly with the cow refusal.
     */
    readonly strategy?: string;
  }) => Promise<WorktreeResult>;
  readonly remove: (input: {
    readonly projectID: string;
    readonly directory: string;
    readonly force: boolean;
  }) => Promise<void>;
  /**
   * The worktree inventory for the project — one `WorktreeInventoryEntry` per
   * directory opencode2 has a record of. Verified against
   * 0.0.0-next-20260917: `projectID` is required (a bare call answers 400),
   * and the listing reconciles as it reads — rows whose directory no longer
   * exists are pruned — so an entry here means the directory is really there.
   */
  readonly list: (input: {
    readonly projectID: string;
  }) => Promise<readonly WorktreeInventoryEntry[]>;
  readonly transform: (
    callback: (editor: WorktreeEditor) => void,
  ) => Promise<{ dispose(): Promise<void> }>;
}