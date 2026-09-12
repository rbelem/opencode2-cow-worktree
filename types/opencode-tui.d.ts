// Ambient declarations for the modules opencode2's TUI runtime hands a plugin
// by specifier rewrite. The installed @opencode-ai/plugin is a v1 build with no
// TUI surface; the running v2 binary resolves `@opencode/plugin/tui`,
// `@opentui/solid` and `solid-js` itself, so they are deliberately not
// installable dependencies. This mirrors types/opencode2-worktree.d.ts, which
// declares the v2 `Context` the v1 package does not type.
//
// This file is a script (no top-level import/export) so its declarations are
// global: the `JSX` namespace below is what tsconfig's `jsx: "preserve"`
// type-checks against, and `jsx` stays "preserve" so tsc never needs to resolve
// a JSX runtime module.
//
// `@opentui/solid` is a devDependency only so tsc can resolve
// `jsxImportSource`; opencode2 supplies the runtime by specifier rewrite.

declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    box: { children?: unknown } & Record<string, unknown>;
    text: { children?: unknown; fg?: string } & Record<string, unknown>;
  }
}

declare module "@opencode/plugin/tui" {
  /** A worktree inventory entry as `client.worktree.list` returns it. */
  export interface WorktreeEntry {
    readonly directory: string;
    readonly strategy?: string;
  }

  /** `context.location` — the session's current directory. */
  export interface PluginLocation {
    readonly directory: string;
    readonly workspaceID?: string;
  }

  /** `sidebar.footer`'s slot input. */
  export interface SidebarFooterProps {
    readonly sessionID: string;
  }

  export interface SlotOptions {
    readonly append: "sidebar.footer";
    readonly render: (props: SidebarFooterProps) => JSX.Element;
  }

  export interface UiDomain {
    slot(options: SlotOptions): void;
  }

  /**
   * `client.worktree.list`'s location argument. `workspace` is the client's
   * spelling of `location.workspaceID`.
   */
  export interface ClientLocation {
    readonly directory?: string;
    readonly workspace?: string;
  }

  export interface WorktreeClient {
    list(input: {
      readonly location: ClientLocation;
    }): Promise<readonly WorktreeEntry[]>;
  }

  export interface OpenCodeClient {
    readonly worktree: WorktreeClient;
  }

  export interface Theme {
    readonly text: {
      readonly default: string;
      readonly subdued: string;
    };
  }

  export interface PluginContext {
    readonly location?: PluginLocation;
    readonly client: OpenCodeClient;
    readonly theme: Theme;
    readonly ui: UiDomain;
  }

  export interface PluginDefinition {
    readonly id: string;
    readonly setup: (context: PluginContext) => void | Promise<void>;
  }

  export const Plugin: {
    define(definition: PluginDefinition): PluginDefinition;
  };
}
