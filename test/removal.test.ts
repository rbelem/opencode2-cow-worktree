import { afterEach, expect, spyOn, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as removal from "../src/removal";

// The quarantine removal's pins: the original path is never deleted in place,
// a swapped identity aborts and restores, and every background failure is
// logged rather than thrown. The filesystem seams (`statDirectory`,
// `renamePath`, `removeTree`) are spied the way `probeUncommitted` is — the
// real function is captured before `spyOn` replaces the export, and the mock
// calls the captured original, never the replaced export.

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * A scratch root with a worktree directory inside it holding one real file.
 * The quarantine sibling lands in the worktree's **parent** — the scratch
 * root — so the afterEach sweep removes every leftover.
 */
async function makePlainDir(prefix: string): Promise<{
  root: string;
  dir: string;
  file: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(root);
  const dir = join(root, "worktree");
  await mkdir(dir);
  const file = join(dir, "precious.txt");
  await writeFile(file, "uncommitted work\n");
  return { root, dir, file };
}

/** Adds a dependency directory, the class the background tail owns. */
async function addNodeModules(dir: string): Promise<string> {
  const nested = join(dir, "node_modules", "dep");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "index.js"), "module.exports = 1;\n");
  return join(dir, "node_modules");
}

/** The `.cow-removing-…` sibling a removal created, when one exists. */
async function findQuarantine(parent: string): Promise<string | undefined> {
  const entries = await readdir(parent);
  const name = entries.find((entry) => entry.startsWith(".cow-removing-"));
  return name === undefined ? undefined : join(parent, name);
}

test("a missing directory resolves as an already-complete removal", async () => {
  const gone = join(tmpdir(), `cow-removal-gone-${Date.now()}-${Math.random()}`);

  await expect(removal.removeQuarantined(gone)).resolves.toBeUndefined();
});

test("remove captures the identity, quarantines, revalidates, and deletes everything", async () => {
  const { root, dir } = await makePlainDir("cow-removal-happy-");

  await expect(removal.removeQuarantined(dir)).resolves.toBeUndefined();

  // The original path was vacated by the rename — never deleted in place —
  // and with no dependency directories the quarantine copy is gone too.
  await expect(lstat(dir)).rejects.toThrow();
  expect(await findQuarantine(root)).toBeUndefined();
});

test("node_modules is deleted by the tail, after remove returns", async () => {
  const { root, dir } = await makePlainDir("cow-removal-tail-");
  await addNodeModules(dir);
  const realTail = removal.deleteHeavyTail;
  // The gate keeps the tail from running while the test checks what the
  // removal itself left behind; releasing it runs the real tail on the
  // arguments the removal handed it.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured: { quarantine: string; heavy: readonly string[] } | undefined;
  const tailSpy = spyOn(removal, "deleteHeavyTail").mockImplementation(
    (quarantine: string, heavy: readonly string[]) => {
      captured = { quarantine, heavy };
      return gate;
    },
  );
  try {
    await expect(removal.removeQuarantined(dir)).resolves.toBeUndefined();

    // remove has returned while the tail is still gated: the original path is
    // gone, and the copy — heavy directory included — waits for the tail.
    await expect(lstat(dir)).rejects.toThrow();
    expect(captured).toBeDefined();
    const quarantine = captured!.quarantine;
    expect(quarantine).toContain(".cow-removing-");
    expect(captured!.heavy).toEqual([join(quarantine, "node_modules")]);
    expect((await lstat(join(quarantine, "node_modules"))).isDirectory()).toBe(true);
    expect(await readFile(join(quarantine, "node_modules", "dep", "index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );

    release();
    await realTail(quarantine, captured!.heavy);
    expect(await findQuarantine(root)).toBeUndefined();
  } finally {
    tailSpy.mockRestore();
  }
});

test("a swapped quarantine path aborts, moves the worktree back, and deletes nothing", async () => {
  const { root, dir, file } = await makePlainDir("cow-removal-swap-");
  const realStat = removal.statDirectory;
  let calls = 0;
  const spy = spyOn(removal, "statDirectory").mockImplementation(async (path: string) => {
    calls += 1;
    const stats = await realStat(path);
    // The second stat is the quarantine re-validation: report a different
    // inode, as if the path were recycled between the rename and the check.
    if (calls === 2) return { dev: stats.dev, ino: stats.ino + 1 } as Stats;
    return stats;
  });
  try {
    const error = await removal
      .removeQuarantined(dir)
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`cow cannot remove ${dir}`);
    expect(error?.message).toContain("nothing was deleted");
    // The abort moved the worktree back: original path, original contents.
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(await findQuarantine(root)).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("a vanished quarantine path is a mismatch and moves the worktree back", async () => {
  const { root, dir, file } = await makePlainDir("cow-removal-vanish-");
  const realStat = removal.statDirectory;
  let calls = 0;
  const spy = spyOn(removal, "statDirectory").mockImplementation(async (path: string) => {
    calls += 1;
    if (calls === 2) {
      throw Object.assign(new Error("the quarantine path is gone"), { code: "ENOENT" });
    }
    return realStat(path);
  });
  try {
    const error = await removal
      .removeQuarantined(dir)
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("nothing was deleted");
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
    expect((await lstat(dir)).isDirectory()).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("a failed move-back chains both errors and strands the files at the quarantine", async () => {
  const { root, dir, file } = await makePlainDir("cow-removal-chain-");
  const realStat = removal.statDirectory;
  const realRename = removal.renamePath;
  let statCalls = 0;
  const statSpy = spyOn(removal, "statDirectory").mockImplementation(async (path: string) => {
    statCalls += 1;
    const stats = await realStat(path);
    if (statCalls === 2) return { dev: stats.dev, ino: stats.ino + 1 } as Stats;
    return stats;
  });
  const renameSpy = spyOn(removal, "renamePath").mockImplementation(
    (from: string, to: string) => {
      if (to === dir) return Promise.reject(new Error("rename-back boom"));
      return realRename(from, to);
    },
  );
  try {
    const error = await removal
      .removeQuarantined(dir)
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("moving the worktree back");
    expect(error?.message).toContain("the files remain at");
    // The chained cause is the move-back failure itself.
    expect((error?.cause as Error).message).toBe("rename-back boom");
    // The move-back failed, so the files are stranded at the quarantine path
    // and the original path holds nothing.
    await expect(lstat(dir)).rejects.toThrow();
    const stranded = await findQuarantine(root);
    expect(stranded).toBeDefined();
    expect(await readFile(join(stranded!, basename(file)), "utf8")).toBe(
      "uncommitted work\n",
    );
  } finally {
    statSpy.mockRestore();
    renameSpy.mockRestore();
  }
});

test("a failed quarantine rename leaves the original directory untouched", async () => {
  const { root, dir, file } = await makePlainDir("cow-removal-norename-");
  const spy = spyOn(removal, "renamePath").mockImplementation(() =>
    Promise.reject(new Error("rename boom")),
  );
  try {
    const error = await removal
      .removeQuarantined(dir)
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`cow cannot remove ${dir}`);
    expect(error?.message).toContain("moving it aside");
    expect((error?.cause as Error).message).toBe("rename boom");
    expect(await readFile(file, "utf8")).toBe("uncommitted work\n");
    expect((await lstat(dir)).isDirectory()).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("a deletion failure leaves the quarantine dir and is logged as well as thrown", async () => {
  const { root, dir, file } = await makePlainDir("cow-removal-stuck-");
  // Fail the quarantine copy of the file, not the original: the original is
  // never passed to rm at all.
  const realRemoveTree = removal.removeTree;
  const spy = spyOn(removal, "removeTree").mockImplementation((path: string) => {
    if (path.includes(".cow-removing-") && basename(path) === basename(file)) {
      return Promise.reject(new Error("rm boom"));
    }
    return realRemoveTree(path);
  });
  const logs: string[] = [];
  const logSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.join(" "));
  });
  try {
    const error = await removal
      .removeQuarantined(dir)
      .then(() => undefined, (failure: unknown) => failure as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("remains are left at");
    expect(error?.message).toContain(".cow-removing-");
    expect((error?.cause as Error).message).toBe("rm boom");
    // The original path is gone; the copy — file included — is not.
    await expect(lstat(dir)).rejects.toThrow();
    const leftover = await findQuarantine(root);
    expect(leftover).toBeDefined();
    expect(await readFile(join(leftover!, basename(file)), "utf8")).toBe(
      "uncommitted work\n",
    );
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("remains are left at");
  } finally {
    spy.mockRestore();
    logSpy.mockRestore();
  }
});

test("a tail failure on a dependency directory is logged, never thrown", async () => {
  const { root, dir } = await makePlainDir("cow-removal-tailfail-");
  const heavy = await addNodeModules(dir);
  const quarantine = join(dir, ".quarantine");
  await mkdir(quarantine);
  const realRemoveTree = removal.removeTree;
  const spy = spyOn(removal, "removeTree").mockImplementation((path: string) => {
    if (path === heavy) return Promise.reject(new Error("rm boom"));
    return realRemoveTree(path);
  });
  const logs: string[] = [];
  const logSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.join(" "));
  });
  try {
    // Resolves — a background failure must not reject into anything.
    await expect(removal.deleteHeavyTail(quarantine, [heavy])).resolves.toBeUndefined();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(heavy);
    expect(logs[0]).toContain("rm boom");
  } finally {
    spy.mockRestore();
    logSpy.mockRestore();
  }
});

test("a tail failure on the quarantine shell is logged and leaves the shell", async () => {
  const { root, dir } = await makePlainDir("cow-removal-shellfail-");
  const heavy = await addNodeModules(dir);
  const quarantine = join(dir, ".quarantine");
  await mkdir(quarantine);
  const realRemoveTree = removal.removeTree;
  const spy = spyOn(removal, "removeTree").mockImplementation((path: string) => {
    if (path === quarantine) return Promise.reject(new Error("rm boom"));
    return realRemoveTree(path);
  });
  const logs: string[] = [];
  const logSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.join(" "));
  });
  try {
    await expect(removal.deleteHeavyTail(quarantine, [heavy])).resolves.toBeUndefined();
    // The dependency directory went; the shell could not and was logged.
    await expect(lstat(heavy)).rejects.toThrow();
    expect((await lstat(quarantine)).isDirectory()).toBe(true);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(quarantine);
    expect(logs[0]).toContain("rm boom");
  } finally {
    spy.mockRestore();
    logSpy.mockRestore();
  }
});
