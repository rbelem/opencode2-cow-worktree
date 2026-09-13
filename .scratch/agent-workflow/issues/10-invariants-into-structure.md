# 10: Invariants into structure — device seam, strategy factory, one prediction

**Found by:** triple-critic review (2026-09-13), unanimous on items 1-3.
All mechanical; behavior-preserving except where noted. One concern per
commit; gate between commits.

**What to build:**

1. `src/device.ts`: move the shared filesystem primitives out of `tool.ts` —
   `deviceOf`, `nearestExistingDevice`, `assertSameDevice`, `crossDeviceError`,
   `isDirectory`. The strategy imports them from `./device` (today it imports
   from `./tool`, inverting the layering). `verifySameDevice` is tool-layer
   policy and stays in `tool.ts`. Strategy tests spy the new module locally
   instead of reaching into `../src/tool`. Update `src/index.ts` (it exports
   `deviceOf`) and `test/index.test.ts`.
2. `createCowStrategy({ postCreate })` factory in `strategy.ts`; `plugin.ts`
   setup registers `createCowStrategy({ postCreate: postCreateHooks(ctx.options) })`.
   Delete `setPostCreateHooks` and the module-level `let postCreate`; the
   setup-ordering contract ("validate before register") becomes structural.
   Tests construct strategies via the factory; the after-each global reset
   goes away.
3. Split `strategy.ts`'s hook runner (`runPostCreateHooks`, `runHookCommand`,
   `hookFailure`, `capturedOutput`, constants) into `src/hooks.ts`, and move
   the impure git probe (`probeUncommitted` / porcelain paths) next to the
   pure decision it feeds — `dirty.ts` stays pure, so the probe goes in its
   own small module (name your call, house style). `strategy.ts` becomes the
   thin composition layer.
4. `predictedParent(input, deps)` helper in `tool.ts`; both the create path
   (`tool.ts` ~145) and `tryAttach` (~342) call it. In `types/opencode2-worktree.d.ts`,
   next to the other pinned upstream facts, record the contract: attach
   assumes opencode2 assembles worktree directories as `<parent>/<name>`
   verbatim, with no sanitization or suffixing.
5. Output-contract drift pins: one test asserting `spawnWorkspaceOutput`'s
   `properties`/`required` match a canonical `SpawnWorkspaceResult` value's
   keys, and the same for `listWorktreesOutput` vs `CowWorktreeEntry` (the
   v1-package constraint forbids generating the schema; a pin is the guard).
6. Badge identity: `strategy-badge.ts` matches inventory rows by exact string
   equality while attach uses basename narrowing + realpath with lexical
   fallback — a symlinked location attaches but shows no badge. Reuse the
   shared matching helper (export it from its module) in the badge, and have
   the badge import the inventory row type from `types/opencode2-worktree.d.ts`
   instead of declaring its own `WorktreeEntry`.

**Blocked by:** None (may proceed in parallel with tickets 08/09; touches
disjoint files except `src/index.ts`'s export list — coordinate nothing,
merge order handles it).

**Status:** ready-for-agent

- [ ] Strategy imports device primitives from `src/device.ts`; tool-layer
      tests no longer spy `../src/tool` for strategy behavior
- [ ] No `setPostCreateHooks`; factory closes over validated hooks; setup
      order enforced by construction
- [ ] Hook runner and git probe live outside `strategy.ts`; `dirty.ts`
      unchanged and still pure
- [ ] Both parent computations route through `predictedParent`; upstream
      assembly contract recorded in the types shim
- [ ] Schema drift pins for both tool outputs
- [ ] Badge uses the shared directory-identity helper and the shared row type
- [ ] Per-commit: `bun test`, `bun run typecheck`, `bun run test:coverage`
      green
