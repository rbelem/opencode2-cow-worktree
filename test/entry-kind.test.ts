import { expect, test } from "bun:test";
import { entryKind } from "../src/entry-kind";
import type { EntryLike, StatLike } from "../src/entry-kind";

/** A `readdir` entry that reports exactly one type. */
function entry(symlink: boolean, directory: boolean, file: boolean): EntryLike {
  return {
    isSymbolicLink: () => symlink,
    isDirectory: () => directory,
    isFile: () => file,
    isSocket: () => false,
    isFIFO: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  };
}

/** A `stat` result that reports exactly one type. */
function stat(symlink: boolean, directory: boolean): StatLike {
  return {
    isSymbolicLink: () => symlink,
    isDirectory: () => directory,
    isSocket: () => false,
    isFIFO: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  };
}

/** The entry fakes above, with one special-type flag flipped true. */
function entryAs(special: keyof Pick<EntryLike, "isSocket" | "isFIFO" | "isBlockDevice" | "isCharacterDevice">): EntryLike {
  return { ...entry(false, false, false), [special]: () => true };
}

/** The stat fakes above, with one special-type flag flipped true. */
function statAs(special: keyof Pick<StatLike, "isSocket" | "isFIFO" | "isBlockDevice" | "isCharacterDevice">): StatLike {
  return { ...stat(false, false), [special]: () => true };
}

/** A `stat` thunk that counts how many times the decision consults it. */
function statProbe(result: StatLike): { calls: () => number; stat: () => Promise<StatLike> } {
  let calls = 0;
  return {
    calls: () => calls,
    stat: async () => {
      calls += 1;
      return result;
    },
  };
}

test("an entry reporting a symlink is a symlink, without stat", async () => {
  const probe = statProbe(stat(false, false));
  expect(await entryKind(entry(true, false, false), probe.stat)).toBe("symlink");
  expect(probe.calls()).toBe(0);
});

test("an entry reporting a directory is a directory, without stat", async () => {
  const probe = statProbe(stat(false, false));
  expect(await entryKind(entry(false, true, false), probe.stat)).toBe("directory");
  expect(probe.calls()).toBe(0);
});

test("an entry reporting a file is a file, without stat", async () => {
  const probe = statProbe(stat(false, false));
  expect(await entryKind(entry(false, false, true), probe.stat)).toBe("file");
  expect(probe.calls()).toBe(0);
});

test("an UNKNOWN entry falls back to stat, and a symlink stat is a symlink", async () => {
  const probe = statProbe(stat(true, false));
  expect(await entryKind(entry(false, false, false), probe.stat)).toBe("symlink");
  expect(probe.calls()).toBe(1);
});

test("an UNKNOWN entry falls back to stat, and a directory stat is a directory", async () => {
  const probe = statProbe(stat(false, true));
  expect(await entryKind(entry(false, false, false), probe.stat)).toBe("directory");
  expect(probe.calls()).toBe(1);
});

test("an UNKNOWN entry falls back to stat, and neither is a file", async () => {
  const probe = statProbe(stat(false, false));
  expect(await entryKind(entry(false, false, false), probe.stat)).toBe("file");
  expect(probe.calls()).toBe(1);
});

test("a socket entry is special without consulting stat", async () => {
  const probe = statProbe(stat(false, false));
  expect(await entryKind(entryAs("isSocket"), probe.stat)).toBe("special");
  expect(probe.calls()).toBe(0);
});

test("a FIFO, block device, and character device entry are special", async () => {
  for (const flag of ["isFIFO", "isBlockDevice", "isCharacterDevice"] as const) {
    expect(await entryKind(entryAs(flag), statProbe(stat(false, false)).stat)).toBe("special");
  }
});

test("an UNKNOWN entry falls back to stat, and a socket stat is special", async () => {
  const probe = statProbe(statAs("isSocket"));
  expect(await entryKind(entry(false, false, false), probe.stat)).toBe("special");
  expect(probe.calls()).toBe(1);
});
