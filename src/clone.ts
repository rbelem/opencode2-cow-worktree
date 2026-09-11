import { constants, type Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Reflink one regular file, sharing its extents with `source`.
 *
 * `COPYFILE_FICLONE_FORCE` makes the copy fail when copy-on-write is
 * unavailable instead of silently falling back to a full byte copy. The error
 * is propagated, never swallowed: a filesystem that cannot share extents must
 * surface as a failure, not as a correct-looking clone made by the wrong
 * mechanism.
 */
export async function reflinkFile(source: string, target: string): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
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
 */
export async function cloneDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cloneInto(source, target);
}

async function cloneInto(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const kind = await kindOf(entry, from);
    if (kind === "directory") {
      await mkdir(to);
      await cloneInto(from, to);
    } else if (kind === "symlink") {
      await symlink(await readlink(from), to);
    } else {
      await reflinkFile(from, to);
    }
  }
}

type EntryKind = "file" | "directory" | "symlink";

async function kindOf(entry: Dirent, path: string): Promise<EntryKind> {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  // Filesystems that do not report a type from readdir report UNKNOWN; lstat
  // is the authoritative fallback and never follows symlinks.
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return "file";
}
