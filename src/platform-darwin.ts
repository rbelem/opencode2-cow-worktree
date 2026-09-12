/**
 * The macOS CoW backend: one regular file cloned with `copyfile(3)`.
 *
 * `clonefile(2)` is not used here on purpose. Apple discourages it for
 * directories — it blocks the whole tree for the duration of the call — so a
 * Deep clone must be driven entry by entry, and `copyfile(3)` is the supported
 * recursive primitive.
 *
 * The syscall is a seam (`DarwinCloneSyscall`) so the decision logic in
 * `cloneFileOnDarwin` runs and is unit-tested on any platform. The real binding
 * lives in `platform-darwin-ffi.ts` and is imported only when a Darwin process
 * actually selects this backend.
 */

/**
 * Flags passed to `copyfile(3)`, from Apple's `copyfile.h`:
 *
 * - `COPYFILE_CLONE_FORCE` (1<<25) is the fail-loud flag: cloning is required,
 *   and an unsupported filesystem returns an error instead of silently
 *   producing a byte copy. Apple documents it as equivalent to `(COPYFILE_EXCL
 *   | COPYFILE_STAT | COPYFILE_XATTR | COPYFILE_DATA | COPYFILE_NOFOLLOW_SRC)`.
 * - `COPYFILE_ALL` (COPYFILE_ACL|COPYFILE_STAT|COPYFILE_XATTR|COPYFILE_DATA) is
 *   added because the clone flag's implied set covers STAT/XATTR/DATA but
 *   **not ACL**. Apple's header: "ACLs will not be cloned unless COPYFILE_ACL
 *   is also passed"; `COPYFILE_ALL` carries that bit. (STAT is already implied,
 *   so the POSIX mode — including the executable bit git reads — is preserved
 *   either way.)
 * - `COPYFILE_EXCL`, implied by the clone flag, means the destination must not
 *   exist — the same precondition the caller's walker already satisfies.
 *
 * Exported so the flag choice is asserted on any platform, without loading the
 * Darwin library.
 */
export const COPYFILE_ALL = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
export const COPYFILE_CLONE_FORCE = 1 << 25;
/** Implied by COPYFILE_CLONE_FORCE; named so the destination precondition is explicit. */
export const COPYFILE_EXCL = 1 << 17;
export const DARWIN_CLONE_FLAGS = COPYFILE_ALL | COPYFILE_CLONE_FORCE;

/**
 * True when the clone genuinely shared extents with the source.
 */
export type CloneOutcome = { readonly cloned: boolean };

/** A `copyfile(3)` clone of one regular file. Throws the raw failure. */
export type DarwinCloneSyscall = (
  source: string,
  destination: string,
) => Promise<CloneOutcome>;

/**
 * The lazily-loaded binding: `loadCopyfileLibrary` and `createDarwinSyscall`
 * from `platform-darwin-ffi.ts`, whose imports are inert so that merely
 * referencing them costs nothing on Linux.
 */
export type DarwinFfi = {
  readonly loadCopyfileLibrary: (typeof import("./platform-darwin-ffi"))["loadCopyfileLibrary"];
  readonly createDarwinSyscall: (typeof import("./platform-darwin-ffi"))["createDarwinSyscall"];
};

/**
 * Composes the binding into a syscall: load libSystem, then build the call over
 * it. Exported and injectable for the same reason the syscall itself is — it is
 * the wiring `cloneFileOnDarwin` falls back to, and it must be provable without
 * a Mac. The default performs the lazy import, so the macOS-only module is
 * pulled in only when a Darwin process actually selects this backend.
 */
export async function darwinSyscall(
  loadFfi: () => Promise<DarwinFfi> = () => import("./platform-darwin-ffi"),
): Promise<DarwinCloneSyscall> {
  const ffi = await loadFfi();
  return ffi.createDarwinSyscall(ffi.loadCopyfileLibrary());
}

/**
 * Clones one regular file, or throws.
 *
 * Fail closed: when the syscall reports success without a real clone, the
 * target is discarded and an error is thrown. A Deep clone that quietly became
 * a full copy is the exact failure this backend exists to prevent, so it is
 * never returned as success.
 *
 * The binding is resolved only inside this default, so importing this module is
 * inert on Linux; both tests and the platform seam injection point supply their
 * own syscall instead.
 */
export async function cloneFileOnDarwin(
  source: string,
  destination: string,
  attempt: DarwinCloneSyscall | undefined = undefined,
): Promise<void> {
  const syscall = attempt ?? (await darwinSyscall());
  const outcome = await syscall(source, destination);
  if (outcome.cloned) return;
  await rm(destination);
  throw new Error(
    `copyfile(3) did not clone ${source} onto ${destination}; refusing a full copy`,
  );
}

async function rm(path: string): Promise<void> {
  const { rm: remove } = await import("node:fs/promises");
  await remove(path, { force: true });
}
