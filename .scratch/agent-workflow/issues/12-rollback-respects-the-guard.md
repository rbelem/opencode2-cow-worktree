# 12: Rollback must never delete a directory the guard refused

**Found by:** lane-fixes (ticket 08 implementation flag). The occupancy guard
in `cloneDirectory` refuses an existing target, but `cowStrategy.create`'s
catch (`src/strategy.ts` ~62) runs the in-place rollback `rm` on
`input.directory` unconditionally — so a foreign directory appearing between
`tryAttach`'s check and the guard is refused-then-deleted at the strategy
layer. The data-loss path from ticket 08 survives one hop without this.

**What to build:**

1. The occupancy refusal becomes distinguishable at the strategy boundary: a
   small internal error class (e.g. `OccupiedTargetError extends Error`,
   exported from `src/clone.ts`, plain message, `cause`-chainable). The house
   "plain Error" rule governs user-facing messages; an internal discriminator
   between two modules is control flow, not surface.
2. `cowStrategy.create`'s catch rethrows `OccupiedTargetError` as-is and skips
   the rollback — nothing in that directory is the plugin's creation. Every
   other failure keeps the existing rollback semantics.
3. Pins at the strategy layer: a refused create (occupied target) leaves the
   foreign directory and its content byte-identical; a mid-clone or
   hook-failure rollback still removes the just-created clone (existing pins
   cover this — keep them green).
4. README: if the create/rollback section describes the rollback, add the
   one-line exception (an occupied target is refused and left untouched).

**Blocked by:** Tickets 08 and 10 (needs the guard to exist; touches
`strategy.ts`, which ticket 10 restructures — land after 10, rebase the
one-line skip onto the new create shape).

**Status:** ready-for-agent

- [x] `OccupiedTargetError` exported from `clone.ts`; refusal throws it
- [x] Strategy rollback skips it and rethrows; all other failures roll back
- [x] Strategy-layer pin: foreign directory survives a refused create intact
- [x] `bun test`, `bun run typecheck`, `bun run test:coverage` all green
