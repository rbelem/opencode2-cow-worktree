import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strategyBadge } from "../strategy-badge";
import type { WorktreeInventoryEntry } from "../types/opencode2-worktree";

// The badge answers with the same directory identity the attach flow uses
// (`inventoryEntryFor` in src/tool.ts), so a location the tool attaches to is
// exactly a location the badge lights up for. Rows are typed as the upstream
// `WorktreeInventoryEntry`, not a local lookalike.

const COW = "/work/source-cow";
const GIT = "/work/source-git";

const entries: readonly WorktreeInventoryEntry[] = [
  { directory: COW, strategy: "cow" },
  { directory: GIT, strategy: "git" },
  { directory: "/work/no-strategy" },
];

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("a matching cow entry yields the cow badge", async () => {
  expect(await strategyBadge(entries, COW)).toBe("cow");
});

test("a matching git entry yields no badge", async () => {
  expect(await strategyBadge(entries, GIT)).toBeUndefined();
});

test("a directory that is not in the inventory yields no badge", async () => {
  expect(await strategyBadge(entries, "/work/absent")).toBeUndefined();
});

test("an empty inventory yields no badge", async () => {
  expect(await strategyBadge([], COW)).toBeUndefined();
});

test("a matching entry with no strategy yields no badge", async () => {
  expect(await strategyBadge([{ directory: COW }], COW)).toBeUndefined();
});

test("an explicitly undefined strategy yields no badge", async () => {
  expect(await strategyBadge([{ directory: COW, strategy: undefined }], COW)).toBeUndefined();
});

test("the project root, which is not listed, yields no badge", async () => {
  expect(await strategyBadge(entries, "/work")).toBeUndefined();
});

test("a symlinked location resolves to the recorded row and yields the badge", async () => {
  // The widening (ticket 10): attach resolves a symlinked ancestor to the
  // recorded directory, so the badge must answer for the same identity — an
  // exact-string badge went dark exactly where the tool attached. The leaf
  // name is the same; an ancestor is the symlink.
  const scratch = await mkdtemp(join(tmpdir(), "cow-badge-"));
  scratchDirs.push(scratch);
  const parent = join(scratch, "parent");
  const real = join(parent, "real-wt");
  await mkdir(real, { recursive: true });
  const linkParent = join(scratch, "link");
  await symlink(parent, linkParent);
  const link = join(linkParent, "real-wt");

  expect(await strategyBadge([{ directory: real, strategy: "cow" }], link)).toBe("cow");
  expect(await strategyBadge([{ directory: real, strategy: "git" }], link)).toBeUndefined();
  expect(await strategyBadge([{ directory: real }], link)).toBeUndefined();
});

test("a differently spelled path lexicalizes to the recorded row and yields the badge", async () => {
  // The matcher's lexical fallback: neither side resolves, so `resolve`
  // normalization decides — a `..` segment in the query still names the row.
  const scratch = await mkdtemp(join(tmpdir(), "cow-badge-lexical-"));
  scratchDirs.push(scratch);
  const real = join(scratch, "real-wt");
  await mkdir(real, { recursive: true });
  const spelled = join(scratch, "other", "..", "real-wt");

  expect(await strategyBadge([{ directory: real, strategy: "cow" }], spelled)).toBe("cow");
});

test("a different directory with the same basename does not match", async () => {
  // Basename narrowing only prunes candidates; identity still has to hold, so
  // a sibling that happens to share the leaf name stays badge-less.
  const scratch = await mkdtemp(join(tmpdir(), "cow-badge-sibling-"));
  scratchDirs.push(scratch);
  const real = join(scratch, "one", "leaf");
  const sibling = join(scratch, "two", "leaf");
  await mkdir(real, { recursive: true });
  await mkdir(sibling, { recursive: true });

  expect(await strategyBadge([{ directory: real, strategy: "cow" }], sibling)).toBeUndefined();
});
