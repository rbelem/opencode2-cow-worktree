/**
 * The shared filesystem primitives both layers of the plugin sit on: the tool
 * (`spawn_workspace`'s pre-create device guard) and the strategy (the `cow`
 * create pre-flight). Both need the same device-identity questions answered,
 * so the primitives live here — a module neither layer owns — instead of the
 * strategy importing them from the tool layer, which would invert the
 * layering: the tool composes the strategy; the strategy must not import from
 * it.
 *
 * Policy lives above these primitives: `verifySameDevice` and
 * `verifyCowSameDevice` — which mechanisms the device rule applies to — are
 * tool-layer decisions and stay in `tool.ts`.
 */
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The device a path's filesystem belongs to, or `undefined` when it cannot be
 * read (a path that does not exist yet, or a permission failure).
 */
export async function deviceOf(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.dev;
  } catch {
    return undefined;
  }
}

/**
 * The actionable `cow` failure for a clone whose target sits on a different
 * filesystem than its source. A reflink cannot cross a device boundary, so the
 * remedy is always to move the target — never to fall back silently.
 *
 * Shared by the tool's pre-create guard and the strategy's own pre-flight so
 * the two name the same cause and the same fix.
 */
export function crossDeviceError(source: string, target: string): Error {
  return new Error(
    `cow cannot clone ${source} into ${target}: the target is on a different ` +
      "filesystem and a reflink cannot cross devices. Point opencode2's " +
      "`worktree.directory` config or the `targetRoot` plugin option (opencode.json) " +
      "at a directory on the source's filesystem.",
  );
}

/**
 * The one cross-device rule: a `cow` clone may cross no device boundary.
 * `undefined` on either side is unknown, not a mismatch.
 */
export function assertSameDevice(
  source: string,
  sourceDevice: number | undefined,
  target: string,
  targetDevice: number | undefined,
): void {
  if (
    sourceDevice === undefined ||
    targetDevice === undefined ||
    sourceDevice === targetDevice
  ) {
    return;
  }
  throw crossDeviceError(source, target);
}

/**
 * Resolves a target that may not exist yet to the first ancestor whose device
 * can be read, so the strategy's pre-flight checks the filesystem the target
 * will actually land on. The root's parent is itself, so the walk terminates;
 * a fully unreadable chain returns `undefined` and the pre-flight proceeds.
 */
export async function nearestExistingDevice(
  path: string,
  probeDevice: (path: string) => Promise<number | undefined>,
): Promise<number | undefined> {
  let current = path;
  for (;;) {
    const device = await probeDevice(current);
    if (device !== undefined) return device;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Whether a path exists and is a directory. The live binding for the tool's
 * `isDirectory` seam, alongside `deviceOf`: a path occupied by a file and a
 * path that is not there at all are the same answer — no existing Worktree.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
