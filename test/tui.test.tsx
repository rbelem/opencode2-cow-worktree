import { afterAll, expect, mock, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createComponent, createRoot, type JSX } from "solid-js";

// `@opencode/plugin/tui` is supplied by opencode2's TUI runtime by specifier
// rewrite, so it is not installable. Mock it before the module under test is
// imported; `Plugin.define` in the real runtime is an identity function, and
// this mock matches that shape exactly.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (definition: unknown) => definition },
}));

const tui = (await import("../tui")).default;
const { RendererContext } = (await import("@opentui/solid")) as unknown as {
  RendererContext: { Provider: unknown };
};

// The badge renders a `<box>`/`<text>`, which construct real opentui
// renderables and therefore need a live RendererContext. A test renderer
// supplies one; the render is wrapped in its Provider below. One renderer is
// shared because the render itself is synchronous and stateless.
const rendererSetup = await createTestRenderer({ width: 40, height: 5 });

/**
 * Renders a registered slot's `render` inside a real RendererContext, so the
 * badge's intrinsic elements resolve. `createRoot` gives the render a reactive
 * owner — the same untracked, one-shot call opencode2's `provide()` makes.
 */
function renderSlot(
  render: (props: { sessionID: string }) => JSX.Element,
): JSX.Element {
  return createRoot((dispose) => {
    let value: JSX.Element = null;
    createComponent(RendererContext.Provider as never, {
      get value() {
        return rendererSetup.renderer;
      },
      get children() {
        value = render({ sessionID: "ses_1" });
        return value;
      },
    });
    dispose();
    return value;
  });
}

afterAll(async () => {
  await rendererSetup.renderer.destroy();
  mock.restore();
});

interface SlotOptions {
  readonly append: string;
  readonly render: (props: { sessionID: string }) => JSX.Element;
}

/** A fake Context exposing exactly the fields `tui.tsx` reads. */
function fakeContext(input: {
  readonly location?: { readonly directory: string };
  readonly list: () => Promise<readonly { directory: string; strategy?: string }[]>;
}): { readonly context: unknown; readonly slot: () => SlotOptions } {
  let captured: SlotOptions | undefined;
  const context = {
    location: input.location,
    client: { worktree: { list: input.list } },
    theme: { text: { default: "#ffffff", subdued: "#808080" } },
    ui: {
      slot: (options: SlotOptions) => {
        captured = options;
      },
    },
  };
  return {
    context,
    slot: () => {
      if (captured === undefined) throw new Error("no slot was registered");
      return captured;
    },
  };
}

test("a cow location registers a sidebar.footer slot that renders the badge", async () => {
  const { context, slot } = fakeContext({
    location: { directory: "/wt" },
    list: async () => [{ directory: "/wt", strategy: "cow" }],
  });

  await tui.setup(context as never);

  expect(slot().append).toBe("sidebar.footer");
  expect(renderSlot(slot().render)).not.toBeNull();
});

test("a git location registers a slot whose render yields null", async () => {
  const { context, slot } = fakeContext({
    location: { directory: "/wt" },
    list: async () => [{ directory: "/wt", strategy: "git" }],
  });

  await tui.setup(context as never);

  expect(renderSlot(slot().render)).toBeNull();
});

test("no location renders null and never queries the worktree list", async () => {
  let calls = 0;
  const { context, slot } = fakeContext({
    list: async () => {
      calls += 1;
      return [];
    },
  });

  await tui.setup(context as never);

  expect(renderSlot(slot().render)).toBeNull();
  expect(calls).toBe(0);
});

test("a rejecting worktree list still registers a slot that renders null", async () => {
  // The `.catch(() => false)` around the resolve must keep a server failure
  // from breaking the footer; setup resolves and the render is a no-op.
  const { context, slot } = fakeContext({
    location: { directory: "/wt" },
    list: async () => {
      throw new Error("worktree list unavailable");
    },
  });

  await tui.setup(context as never);

  expect(renderSlot(slot().render)).toBeNull();
});
