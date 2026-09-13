# 03: Upstream-issues decision doc

**What to build:** `docs/research/upstream-issues.md` — a decision memo of
five upstream candidates, explicitly **not filed**; the owner reads it later
and decides. Each candidate: problem statement, evidence links (commits,
PRs, source refs), plugin-side workaround status, and a "file it if…"
recommendation.

Candidates: (1) Desktop `strategy: "git"` hardcode — verdict: no supported
plugin-side workaround; (2) `instanceof`/`forceRequired` breakage for
installed plugins — worked around at `dcc8ce1`; (3) registry/attach pattern
— plugin-local by design, cross-ref ADR 0003; (4) post-create hook point in
the strategy interface — plugin-local for now; (5) session listing for
server plugins — new candidate; only the TUI context exposes a client today.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] All five candidates present with evidence links and workaround status
- [ ] Each has an explicit recommendation and filing guidance
- [ ] Doc lives in `docs/research/` matching the existing research-doc style
