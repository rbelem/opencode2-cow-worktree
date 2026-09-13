# 09: Capability probe — cache only terminal outcomes, never let cleanup mask a verdict

**Found by:** triple-critic review (2026-09-13), all three critics
independently. `src/capability.ts` caches the probe promise unconditionally —
including `{ status: "error" }` — and never invalidates. `error` is the one
verdict class defined as transient (ENOSPC, EACCES, an I/O hiccup), so one bad
moment at first probe disables `spawn_workspace` for that path until server
restart. Separately, the `finally` block's `rm` can throw and mask a
successful probe as `error` — which today would also be cached.

**What to build:**

1. Only `supported` and `unsupported` are cached. An `error` result is
   removed from the cache when the promise settles (or simply never stored —
   store only after classification; pick the shape that keeps the
   concurrent-calls-share-one-probe property intact, which the current
   promise-cache provides).
2. The scratch cleanup must not mask the verdict: perform the `rm` in its own
   try/catch that ignores failure (the scratch dir is dot-prefixed and tiny;
   a failed cleanup must never turn `supported` into `error`). Comment the why.
3. Keep the per-directory key (device-keyed caching was reviewed and
   dismissed as speculative).
4. Pins: an `error` verdict is not cached (two calls, injectable attempt
   invoked twice; second call succeeding yields `supported`); a failing
   scratch `rm` still yields `supported`; concurrent calls still share one
   probe.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] `error` verdicts retry on the next call; terminal verdicts stay cached
- [ ] Scratch-cleanup failure cannot mask a probe verdict
- [ ] Concurrency property (shared in-flight probe) still pinned
- [ ] `bun test`, `bun run typecheck`, `bun run test:coverage` all green
