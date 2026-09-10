// Augmentations for opencode2 plugin API members that the running binary
// implements but the published @opencode-ai/plugin beta has not yet typed.
//
// The installed beta (0.0.0-beta-17639) Context has no `worktree` domain and no
// `location`; the running opencode2 build (v2 HEAD, packages/plugin 1.18.15)
// exposes both. `Plugin.define` is an identity function at runtime, so code
// using them runs today and type-checks once the published package catches up.
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
