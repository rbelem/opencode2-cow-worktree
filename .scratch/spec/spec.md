# Spec — opencode2-cow-worktree

## Problem Statement

A developer running several agents in parallel has to give each one its own
working directory, or they corrupt each other's files. The built-in `git`
worktree strategy shares the repository's object database and carries tracked
files only. It cannot carry ignored state: dependency directories, build
caches, virtual environments, local configuration. An agent handed a bare
checkout spends its first minutes reinstalling what was already there, and an
agent that assumes that state exists fails in confusing ways.

Making a full copy of the working directory solves the state problem but not
the parallel one: a full copy of a large checkout is slow and expensive, and
running several at once is worse.

## Solution

A plugin for opencode2 that registers a copy-on-write worktree strategy. Asking
for a worktree with `strategy: "cow"` produces a **Deep clone**: the entire
working directory, ignored files included, whose extents are shared with the
source until either side writes. It occupies almost no additional space and is
created in milliseconds, so several agents can each have a complete, genuinely
independent checkout at once.

Because opencode2 already owns worktree lifecycle, the plugin inherits create,
remove, list, refresh, the strategy recorded at removal time, and the project
setup script. The plugin contributes the clone itself and a tool that probes
for CoW capability and picks between the clone and the built-in `git` strategy.

## User Stories

1. As an agent orchestrator, I want a working directory that carries ignored
   files, so that a delegated agent starts from a ready-to-run checkout.
2. As an agent orchestrator, I want creating that directory to be fast, so that
   fanning out several agents in parallel is not dominated by setup.
3. As an agent orchestrator, I want each agent's directory to be genuinely
   independent, so that concurrent writes cannot collide.
4. As a developer, I want the clone to contain a real `.git`, so that git
   behaves identically in the clone and the source and no repository can be
   corrupted by a missing object store.
5. As a developer, I want worktrees created this way to appear in
   `worktree.list`, so that opencode2's inventory stays honest.
6. As a developer, I want `worktree.remove` to clean up a clone, so that I do
   not accumulate directories.
7. As a developer, I want the project setup script to run after a clone is
   created, so that clones behave like every other worktree.
8. As a developer, I want the plugin to decide whether a clone is possible, so
   that I do not have to know my filesystem's type.
9. As a developer, I want capability detection to be based on attempting a
   clone rather than inspecting the filesystem, so that it is correct on
   filesystems where support is a format-time property.
10. As a developer on a machine without CoW support, I want a clear error by
    default, so that I am not silently given a different kind of directory.
11. As a developer on a machine without CoW support, I want to opt into a
    fallback, so that I can still get worktrees in areas where the fallback is
    good enough.
12. As a developer, I want the fallback to be off unless I enable it, so that
    the mechanism I asked for is the mechanism I get.
13. As a developer, I want to be told which mechanism produced a directory, so
    that I can reason about whether it has the state I expect.
14. As a developer, I want to name the strategy explicitly, so that I can pick
    the git worktree when I know that is what I want.
15. As an agent, I want a single call that creates the directory and starts a
    session in it, so that spawning a parallel worker is one step.
16. As a developer, I want capability results cached per source directory, so
    that repeated spawns do not repeat the probe.
17. As a developer, I want to edit tracked and ignored files in a clone
    without affecting the source, so that I can trust the isolation.
18. As a developer, I want the source working directory to be unaffected by
    anything done in a clone, so that isolation is genuinely two-way.
19. As a maintainer, I want the plugin to use opencode2's own strategy registry
    rather than a parallel subsystem, so that there is one worktree lifecycle
    and not two.
20. As a maintainer, I want the plugin to work with the plugin package published
    today, so that it can be installed without forking opencode2.
21. As a maintainer, I want tests to run against a real scratch repository, so
    that clone correctness is proven against git's own view of the repository.
22. As a maintainer, I want the CoW-unavailable branch testable without a
    filesystem that lacks support, so that the fallback policy is verified.
23. As a maintainer, I want the project glossary to fix the vocabulary, so that
    Workspace, Location, Worktree, and Strategy are not used loosely.
24. As a prospective user, I want the plugin to be unpublished until it is
    tested, so that I am not misled by an abandoned experiment.

## Implementation Decisions

**The plugin registers one worktree strategy with the id `cow`, through the
plugin API's worktree seam.** The strategy is a free-choice string id; the
registry is open. Registering it makes it the location's default, and a caller
may still select `git` explicitly. See ADR 0001.

**The strategy interface is: create takes a source directory, a target
directory, and an optional branch, and returns the created directory; remove
takes a directory and a force flag; list takes a source directory and returns
entries tagged `root` or `worktree`.** `create` must return a directory that
opencode2 validates, and `list` entries must match its expected shape. This is
the strategy contract as published by opencode2, not a shape of our choosing.

**A Deep clone reflinks every regular file recursively, recreates directories
and symbolic links, and includes the `.git` directory in the walk.** Objects in
a git object database are immutable, so sharing their extents is safe. The
clone therefore has a genuine standalone `.git` — no `alternates`, no
dependency on the source's object store, and git cannot tell the clone from an
ordinary repository. Symbolic links are recreated, not followed. Hard links are
reflinked like any other file. `.git` is not skipped and not re-created through
`clone --shared`; that alternative is explicitly rejected because it makes the
clone depend on the source.

**CoW capability is a predicate over a directory, implemented by attempting a
clone of a small temporary file in that directory's filesystem, then discarding
both.** Filesystem type is not consulted, because availability is a format-time
property on at least one filesystem and because a clone can fail across device
boundaries. The result is cached per source directory.

**The strategy fails loudly when CoW is unavailable.** Silent fallback inside a
strategy would mean that asking for `cow` can produce a git worktree, which
contradicts the mechanism the caller named. The fallback policy lives in the
tool, not in the strategy.

**A single tool creates the directory and starts a session in it.** The call
takes optional needs and an optional force-mechanism override, and returns the
session id, the directory, and the mechanism that produced it. The mechanism
value is either `cow` or `git`. The tool consults the capability predicate,
applies the configured fallback policy, and reports which branch it took.

**Fallback is a plugin option, defaulting to disabled.** The option is read
from the plugin's configuration options. With fallback disabled — the default —
a request for a clone on a filesystem without CoW support produces a hard
error. With fallback enabled and set to the git mechanism, the tool produces a
git worktree instead and reports `git` as the mechanism. There are no other
fallback values.

**The strategy's `list` returns clones it created, tracked through plugin
storage, one key per clone recording its source directory.** Declared state is
preferred to discovering directories by naming convention. This mirrors the
pattern opencode2's own worktree test fixture uses.

**No reconcile helper ships.** A clone contains a real `.git` and therefore a
real diff; the orchestrator can run git itself. Adding a diff or apply tool is
surface area with no corresponding gain.

**The public API of the plugin is the strategy id, the tool, and the plugin
options.** Nothing else is exported for callers.

**Types for the plugin API members this plugin uses are declared locally**,
because the published plugin package does not yet type the worktree and
location members that the running opencode2 build implements. The local
declaration is removable once the published package catches up; this is a
chore, not a design decision.

**Glossary and decision records:** `CONTEXT.md` fixes the vocabulary
(Workspace, Location, Worktree, Strategy, CoW clone, Deep clone, Shallow
worktree, CoW capability). ADR 0001 records why the clone is a worktree
strategy rather than a separate subsystem or a workspace provider.

## Testing Decisions

**Good tests here assert external behavior: given a source repository and a
request for a `cow` worktree, the produced directory is what a user would
expect.** They do not assert how the clone was performed, which syscall was
used, or that a particular helper function was called. A test that would still
pass if the clone implementation were replaced with a different correct
implementation is a good test.

**Seam one — the strategy, tested against a real scratch repository.** Create a
repository with tracked files, an ignored directory standing in for a dependency
directory, and a symbolic link. Register the strategy, create a worktree
through it, then assert: the clone's files match the source; an ignored file is
present; the symbolic link is a link and not a copy of its target; a real `.git`
exists and git reports a clean state matching the source; editing a tracked and
an ignored file in the clone leaves the source untouched; and the clone's
reported size does not include the shared extents. This is the highest seam and
covers the majority of the user stories.

**Seam two — the capability predicate, tested directly.** Assert that it
returns true on a copy-on-write filesystem and cleans up its temporary files.
The false branch is asserted through seam three with a stubbed predicate, because
it cannot be produced on demand.

**Seam three — the tool, tested with a stubbed capability predicate.** Assert
the fallback policy: with fallback disabled, a positive and a negative
capability produce success and a hard error respectively; with fallback enabled,
a negative capability produces a directory by the git mechanism and the result
reports `git`; and the reported mechanism always matches the directory actually
produced.

**Prior art** is opencode2's own worktree test fixture and its server-level
worktree tests, which register a strategy, exercise create/list/remove through
the interface, and assert the produced directories. Our tests follow that
shape because it is the same seam opencode2 itself tests at.

**Not tested directly:** the recursive clone walk, the reflink invocation, and
the temporary-file probe internals. These are implementation behind seam one and
seam two.

## Out of Scope

- Publishing to a package registry. The repository is private until it has been
  tested; announcing is a separate decision.
- Reconciliation of parallel work: merging, diffing, or applying patches between
  worktrees.
- Filesystem snapshots as a cloning mechanism, as distinct from reflink clones.
- Windows and macOS backend implementations, beyond the predicate reporting
  them as unsupported.
- A distinct namespace or prefix for the directories the plugin creates, beyond
  whatever opencode2's own directory configuration and naming already provide.
- Any change to opencode2 itself, including its config schema. This plugin
  extends opencode2 through its public plugin API only.
- Sharing one directory between two worktrees, or any notion of read-only
  worktrees.

## Further Notes

- The repository is `opencode2-cow-worktree` under
  `~/Workspace/github.com/rbelem/`. It is scaffolded, committed, and has no
  remote.
- The running opencode2 build is a preview (`0.0.0-next-...`) whose plugin
  package version and plugin types may lag the binary. This affects typing, not
  runtime behavior; the plugin's runtime dependency is the plugin API's
  worktree seam, which the build implements.
- The strategy id `cow` is a free non-empty string. Selecting a strategy is
  explicit in the create input, so the absence of a fallback is not a special
  case in the strategy: it is simply not passing `cow`.
- The distinction this plugin exists to make is Deep clone versus Shallow
  worktree. The built-in `git` strategy is the latter and remains the fallback
  mechanism.
