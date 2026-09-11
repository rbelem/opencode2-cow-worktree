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
  }) => Promise<WorktreeResult>;
  readonly remove: (input: {
    readonly directory: string;
    readonly force: boolean;
  }) => Promise<void>;
  readonly transform: (
    callback: (editor: WorktreeEditor) => void,
  ) => Promise<{ dispose(): Promise<void> }>;
}