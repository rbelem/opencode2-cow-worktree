/**
 * The platform seam: which syscall fulfils a CoW clone.
 *
 * On Linux the primitive is a reflink (`COPYFILE_FICLONE_FORCE`). On macOS it
 * is `copyfile(3)` with `COPYFILE_CLONE_FORCE`, because libuv never reached
 * `clonefile(2)` on Darwin even on APFS — under Node the reflink call fails
 * with `ENOSYS` unconditionally. `cloneFile` and `isDarwin` are the only
 * platform-specific things the rest of the code touches.
 */

/**
 * The CoW clone operation for one regular file: shares the target's extents
 * with `source`, or throws. Never falls back to a byte copy.
 */
export type CloneFile = (source: string, target: string) => Promise<void>;

/**
 * True on Darwin. Injectable into `cloneFile` so the platform dispatch is
 * exercised from a Linux test.
 */
export type PlatformCheck = () => boolean;

/** True when the current process is running on macOS. */
export function isDarwin(): boolean {
  return process.platform === "darwin";
}

const defaultIsDarwin: PlatformCheck = isDarwin;

/**
 * Clones one regular file using this platform's syscall, or throws.
 *
 * Dispatch is by `platform` so the Darwin branch is reachable from tests on
 * Linux. On Linux this is exactly the previous behavior:
 * `COPYFILE_FICLONE_FORCE` on the same paths.
 */
export async function cloneFile(
  source: string,
  target: string,
  platform: PlatformCheck = defaultIsDarwin,
): Promise<void> {
  if (platform()) return cloneOnDarwin(source, target);
  return cloneOnLinux(source, target);
}

/** The Linux primitive: a forced reflink, which fails rather than byte-copying. */
export async function cloneOnLinux(source: string, target: string): Promise<void> {
  const { constants } = await import("node:fs");
  const { copyFile } = await import("node:fs/promises");
  await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
}

/**
 * The Darwin backend, loaded only when selected. The dynamic import keeps the
 * macOS module — and its `bun:ffi` `dlopen` — out of the Linux process.
 */
async function cloneOnDarwin(source: string, target: string): Promise<void> {
  const { cloneFileOnDarwin } = await import("./platform-darwin");
  await cloneFileOnDarwin(source, target);
}
