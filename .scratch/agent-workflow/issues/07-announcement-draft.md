# 07: Draft the community announcement (posting stays human)

**What to build:** a publication-ready draft announcement for
`opencode2-cow-worktree` at `docs/announcement-draft.md`, so the owner can
review, edit, and post it when timing is chosen. The draft tells the
battle-tested story with receipts:

- What the plugin is: `cow` worktree strategy for opencode2 — Deep clones via
  reflink (~25 ms, ~0 extra disk, ignored files carried), `spawn_workspace`,
  attach semantics, `list_worktrees`, post-create hooks, quarantine removal.
- The verification story: 100% lines+functions coverage gate, the live
  31-scenario parallel-agent swarm on `v0.0.0-next-20260912.3`
  (`docs/e2e/run-2026-09-12-swarm.md`), the four-scenario e2e harness
  (105 checks) against real servers.
- Honest limits section: Desktop cannot select plugin strategies today
  (`strategy: "git"` hardcode — link `docs/research/desktop-strategy-hardcode.md`);
  dirty worktrees are safe-but-unremovable from the TUI until upstream's
  structured-error path is fixed; no real-LLM fan-out in e2e.
- Known upstream candidates exist in `docs/research/upstream-issues.md` — the
  draft should NOT promise filings; the owner decides separately.

Tone: plain, technical, no hype. Include install/config copy consistent with
the README (private package — the announcement should reflect however the
owner plans to publish; leave a `TODO(owner)` marker for the publish path
rather than inventing one).

**Blocked by:** None (can start immediately).

**Status:** draft delivered (docs/announcement-draft.md); posting stays owner

- [ ] Draft covers what/why, verification receipts, honest limits, and
      install pointer
- [ ] Every factual claim traces to a repo doc (no invented numbers)
- [ ] `TODO(owner)` markers for publish path and post timing
- [ ] Posting does NOT happen; draft only

## Publish-time checklist (added 2026-09-13, from the triple-critic review)

Decisions the announcement/publish step must carry; no code change now:

- [x] Global default blast radius: installing the plugin makes `cow` the
      Location default strategy with no capability gate on the default
      (TUI/API) path — a non-CoW machine that never asked for the plugin
      gets failing default worktree creates. Decide: install-requirement
      docs, or ask upstream for a non-default registration option. Note the
      Desktop hardcode currently masks this on Desktop; filing that fix
      un-masks it.
      DECIDED 2026-09-14: documented as an install requirement in the
      README Install section ("What installing changes"); no upstream ask.
- [x] Public API: the barrel exports 16 symbols; the only external consumer
      (the install shim) uses `default`. Decide the real API at publish
      (likely `export { default }` plus the `./tui` entry) instead of
      freezing an accidental surface.
      DECIDED 2026-09-14: slimmed to `export { default }` before publish;
      the barrel pin test holds the surface to that decision.
