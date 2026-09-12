/**
 * How a directory entry is materialised by the clone walker, kept a pure
 * decision so it can be tested without a real filesystem.
 *
 * `readdir` reports an entry's type on the filesystems this tool targets, but
 * the POSIX contract allows it to report UNKNOWN (all of `isSymbolicLink`,
 * `isDirectory` and `isFile` false). When that happens `stat` is the
 * authoritative fallback; it must be `lstat`, which never follows a symlink,
 * or a link would be classified by its target.
 */

/** How a directory entry is materialised by the clone walker. */
export type EntryKind = "file" | "directory" | "symlink";

/** The slice of a `readdir` Dirent this decision reads. */
export interface EntryLike {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** The slice of `lstat` this decision reads; `lstat` never follows a symlink. */
export interface StatLike {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export async function entryKind(entry: EntryLike, stat: () => Promise<StatLike>): Promise<EntryKind> {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  const stats = await stat();
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return "file";
}
