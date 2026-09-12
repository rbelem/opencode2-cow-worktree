import {
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { entryKind } from "./entry-kind";
import { cloneFile } from "./platform";

/**
 * CoW-clone one regular file, sharing its extents with `source`.
 *
 * Dispatches to the platform backend: `COPYFILE_FICLONE_FORCE` on Linux, and
 * `copyfile(3)` with `COPYFILE_CLONE_FORCE` on macOS. Both fail instead of
 * falling back to a full byte copy; the error is propagated, never swallowed.
 * A filesystem that cannot share extents must surface as a failure, not as a
 * correct-looking clone made by the wrong mechanism.
 */
export async function reflinkFile(source: string, target: string): Promise<void> {
  await cloneFile(source, target);
}

/**
 * Deep clone `source` into `target`: recursively reflink every regular file and
 * recreate every directory and symbolic link, `.git` included.
 *
 * Symbolic links are recreated, never followed, so a link in the clone is a
 * link. Hard links are reflinked like any other file. The target directory is
 * created if missing. `.git` is walked like any other directory — the clone
 * gets a genuine standalone metadata directory and no dependency on the
 * source's object store. Throws when reflinking is unavailable; there is no
 * copy fallback.
 *
 * A target inside the source is legitimate — opencode2 resolves a relative
 * `worktree.directory` against the project checkout — so the target subtree is
 * skipped rather than copied into itself. A target that contains the source is
 * rejected: writing the clone over the tree being walked has no coherent
 * meaning.
 */
export async function cloneDirectory(source: string, target: string): Promise<void> {
  const from = resolve(source);
  const to = resolve(target);

  if (from === to) {
    throw new Error(`cannot clone ${from} into itself`);
  }
  if (isInside(from, to)) {
    throw new Error(`cannot clone ${from} into ${to}: the target contains the source`);
  }

  await mkdir(target, { recursive: true });
  await cloneInto(from, to, to);
}

async function cloneInto(source: string, target: string, skip: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    // The target (when it lives inside the source) must not be copied: it is
    // being populated by this very walk, so descending into it clones the
    // clone into itself without bound. Everything else — including the
    // target's ancestors and their other children — is copied normally.
    if (from === skip) continue;
    const to = join(target, entry.name);
    const kind = await entryKind(entry, () => lstat(from));
    if (kind === "directory") {
      await mkdir(to);
      await cloneInto(from, to, skip);
    } else if (kind === "symlink") {
      await symlink(await readlink(from), to);
    } else {
      await reflinkFile(from, to);
    }
  }
}

/**
 * True when `child` lies inside `parent`, compared by path components rather
 * than by string prefix: `/a/bc` is not inside `/a/b`, and a child literally
 * named `..foo` is not an escape. `relative` yields exactly that check, and an
 * absolute result means a different root and therefore not contained.
 */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
