import { expect, test } from "bun:test";

// `src/index.ts` is the package entry point and was never exercised: every
// other test imports a module directly. Importing it here proves the barrel
// resolves and that nothing re-exported has been renamed or dropped.
const mod = await import("../src/index");

test("the default export is the plugin with its id and setup", () => {
  expect(mod.default.id).toBe("opencode2-cow-worktree");
  expect(typeof mod.default.setup).toBe("function");
});

test("every named runtime export is a function", () => {
  // A literal list, not an iteration over the module: a loop over Object.keys
  // would silently pass when an export is missing. `cowStrategy` is excluded
  // here because it is the `cow` WorktreeDefinition object, asserted below.
  const names = [
    "cloneDirectory",
    "reflinkFile",
    "cloneFile",
    "isDarwin",
    "cloneFileOnDarwin",
    "probeCowCapability",
    "spawnWorkspace",
    "deviceOf",
    "fallbackPolicy",
    "targetRoot",
  ] as const;

  for (const name of names) {
    expect(typeof mod[name]).toBe("function");
  }
});

test("cowStrategy is the cow WorktreeDefinition, not a function", () => {
  expect(mod.cowStrategy).toMatchObject({ id: "cow" });
  expect(typeof mod.cowStrategy.create).toBe("function");
  expect(typeof mod.cowStrategy.remove).toBe("function");
  expect(typeof mod.cowStrategy.list).toBe("function");
});
