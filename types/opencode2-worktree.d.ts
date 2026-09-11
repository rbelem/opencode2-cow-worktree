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
  readonly transform: (
    callback: (editor: WorktreeEditor) => void,
  ) => Promise<{ dispose(): Promise<void> }>;
}
