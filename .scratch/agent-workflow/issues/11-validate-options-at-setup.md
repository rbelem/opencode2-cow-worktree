# 11: Validate every plugin option at setup; make the README true

**Found by:** triple-critic review (2026-09-13). `hooks.postCreate` is
validated eagerly in `setup` and fails the plugin load; `fallback` and
`targetRoot` are validated lazily inside `liveDeps(ctx)` on every tool
invocation. The asymmetry is load-bearing in the worst way: the
`list_worktrees` handler builds "own minimal deps, not liveDeps" specifically
to dodge a misconfigured clone option failing a read-only call
(`plugin.ts` ~219). The README asserts all three options "fail the plugin
load loudly" — contradicting the code and the README's own earlier text.

**What to build:**

1. `setup` validates all three options once — `postCreateHooks(options)`,
   `fallbackPolicy(options)`, `targetRoot(options)` — and passes the
   validated values into the `liveDeps` closures. `liveDeps` stops
   re-validating.
2. `list_worktrees` keeps its minimal deps, but the comment explaining the
   dodge is updated (or removed) — the validation side effect no longer
   exists.
3. README: the hooks section (and any other mention) states the now-true
   behavior for all three options. Grep for "plugin load" and "throws when
   the tool runs" and reconcile every claim.
4. Pins: a misconfigured `fallback` or `targetRoot` fails `setup` (plugin
   load), not the first tool call; a valid configuration registers both
   tools and the tool path uses the validated values (existing
   `plugin-fallback` tests adjusted).

**Blocked by:** Ticket 10 (both rewrite `plugin.ts` `setup`; land 10 first,
then this rebases trivially — if working in parallel lanes, expect a small
setup-region conflict for the orchestrator to resolve).

**Status:** ready-for-agent

- [x] All three options validated once at `setup`; `liveDeps` consumes
      validated values
- [x] `list_worktrees` dodge comment reconciled
- [x] README claims match behavior for all three options
- [x] Per-commit: `bun test`, `bun run typecheck`, `bun run test:coverage`
      green
