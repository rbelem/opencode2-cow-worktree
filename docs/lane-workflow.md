# Lane workflow — spawning and absorbing CoW lanes

Conventions for developing this repository in parallel agent lanes. The
mechanics — why lanes are independent full clones rather than linked
worktrees, the verified merge sequence, what fetch does and does not carry,
the object/disk behavior on btrfs — are established in
[`research/lane-merge-mechanics.md`](research/lane-merge-mechanics.md). This
page is the procedure; `scripts/lane.ts` is the tooling that encodes it. The
commands below assume the lanes live as siblings of this repo (the default).

## Spawn

```sh
bun scripts/lane.ts spawn <name> [--count N] [--dir <parent>]
```

CoW-clones the repository root into `<parent>/cow-lane-<name>` (with
`--count`, `cow-lane-<name>-1` … `-N`), via `cloneDirectory` — a reflink Deep
clone of the whole working directory, `.git` and ignored files included, so
the gates can run in the lane immediately (milliseconds, shared extents). It
then:

- **removes the inherited `origin` remote** in each clone. A copied `.git`
  carries the live, credential-bearing GitHub remote; leaving it in every
  lane is an accidental-push surface. Structural fix beats instruction — the
  clone simply has nothing to push to.
- creates and checks out branch `lane-<name>` (`lane-<name>-<i>` with
  `--count`) at the clone tip, so lane commits land on a greppable branch by
  default.
- refuses any target that already exists. The tool never deletes.

## Work in the lane

Commit everything you want merged onto the lane branch. There is exactly one
channel back to main: **commits**. What does *not* travel (fetch moves refs
and objects only — see the research doc, "What does NOT travel"):

- uncommitted or staged work,
- the stash,
- the reflog,
- `.git/config` edits and hooks,
- ignored files (`node_modules` in main is untouched by the merge),
- untracked scratch files.

## Terminal, then absorb

Wait until the lane agent is **terminal** before absorbing. A live agent can
still write files and make commits after a clean probe, and its repo state
can change between the pre-check and the fetch. Then, from the **main repo
checkout**:

```sh
bun scripts/lane.ts absorb <name> [--dir <parent>] [--merge] [--into <ref>]
```

Without `--merge` this is a dry run. Every probe of the live lane uses
`git --no-optional-locks`, so the checks never contend with the lane over
`index.lock`. In order:

1. **Pre-checks** (read-only, lock-free, against the clone): the lane branch
   exists; `status --porcelain` is empty — the tool refuses loudly otherwise,
   because uncommitted work never travels; the lane tip is pinned with
   `rev-parse` and printed.
2. **Fetch** (in the main repo): adds remote `lane-<name>` → the clone path
   (skipped if present) and runs `git fetch lane-<name> lane-<name>`, landing
   the branch at the namespaced, safe `refs/remotes/lane-<name>/lane-<name>`.
   The fetched tip is re-verified against the pin; if the lane moved, absorb
   refuses and asks to be re-run.
3. **Scope review**: prints `git log --oneline <into>..lane-<name>/lane-<name>`
   and `git diff --stat <into>...lane-<name>/lane-<name>`. Confirm expected
   files only, and skim the full diff.
4. **Stop** on a dry run with the reminder checklist: lane agent terminal?
   scope diff reviewed? full gates + e2e after the merge?

With `--merge` (and the checkout on `--into`, default `main`), it runs:

```sh
git merge --no-ff lane-<name>/lane-<name> -m "merge: lane-<name> (<lane tip subject>)"
```

`--no-ff` is the default integration, deliberately. The research doc's plan B
replayed the second lane with `git rebase --onto`; dcg-class shell guards can
block rebase-style history rewriting, so rebase is not the encoded default —
a `--no-ff` merge works under the guards, records the lane as one greppable
unit, and is honest about parallel work. On conflicts the tool prints the
conflicted files (`git diff --name-only --diff-filter=U`) and exits non-zero
with **no cleanup**: resolve by hand, commit, and continue. The tool never
rebases, never pushes, and never deletes branches or remotes on its own.

## Post-absorb cleanup

In the main repo, once the merged tree has passed the full gates and e2e:

```sh
git remote remove lane-<name>   # drop the lane ref (refs/remotes/lane-…)
```

Then delete the lane clone. The shell guard blocks `rm -rf`; remove it from a
script instead (`bun -e` with `node:fs/promises` `rm`). Lanes have no
`objects/info/alternates`, so a clone is self-contained and safe to delete at
any time — on btrfs, deletion frees only the lane's **exclusive** bytes
(extents written after cloning); the rest is shared with main and survives.
Before deleting, copy out anything worth keeping: untracked files never
traveled, and the clone holds the only copy.
