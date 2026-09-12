import { expect, test } from "bun:test";
import { strategyBadge } from "../strategy-badge";
import type { WorktreeEntry } from "../strategy-badge";

const COW = "/work/source-cow";
const GIT = "/work/source-git";

const entries: readonly WorktreeEntry[] = [
  { directory: COW, strategy: "cow" },
  { directory: GIT, strategy: "git" },
  { directory: "/work/no-strategy" },
];

test("a matching cow entry yields the cow badge", () => {
  expect(strategyBadge(entries, COW)).toBe("cow");
});

test("a matching git entry yields no badge", () => {
  expect(strategyBadge(entries, GIT)).toBeUndefined();
});

test("a directory that is not in the inventory yields no badge", () => {
  expect(strategyBadge(entries, "/work/absent")).toBeUndefined();
});

test("an empty inventory yields no badge", () => {
  expect(strategyBadge([], COW)).toBeUndefined();
});

test("a matching entry with no strategy yields no badge", () => {
  expect(strategyBadge([{ directory: COW }], COW)).toBeUndefined();
});

test("an explicitly undefined strategy yields no badge", () => {
  expect(strategyBadge([{ directory: COW, strategy: undefined }], COW)).toBeUndefined();
});

test("the project root, which is not listed, yields no badge", () => {
  expect(strategyBadge(entries, "/work")).toBeUndefined();
});
