import { expect, test } from "bun:test";
import { fallbackPolicy, targetRoot } from "../src/config";

test("absent options disable the fallback", () => {
  expect(fallbackPolicy(undefined)).toBe("none");
});

test("empty options disable the fallback", () => {
  expect(fallbackPolicy({})).toBe("none");
});

test("an explicit git enables the fallback", () => {
  expect(fallbackPolicy({ fallback: "git" })).toBe("git");
});

test("an explicit none disables the fallback", () => {
  expect(fallbackPolicy({ fallback: "none" })).toBe("none");
});

test("an unrecognized value fails loudly, naming the key and accepted values", () => {
  expect(() => fallbackPolicy({ fallback: "bogus" })).toThrow(/fallback/);
  expect(() => fallbackPolicy({ fallback: "bogus" })).toThrow(/none, git/);
});

test("a non-string value fails loudly rather than degrading to none", () => {
  expect(() => fallbackPolicy({ fallback: true })).toThrow(/fallback/);
  expect(() => fallbackPolicy({ fallback: 1 })).toThrow(/fallback/);
});

test("absent options leave the target root unset", () => {
  expect(targetRoot(undefined)).toBeUndefined();
});

test("empty options leave the target root unset", () => {
  expect(targetRoot({})).toBeUndefined();
});

test("a configured target root is returned verbatim", () => {
  expect(targetRoot({ targetRoot: "/mnt/worktrees" })).toBe("/mnt/worktrees");
});

test("a non-string or empty target root fails loudly, naming the key", () => {
  expect(() => targetRoot({ targetRoot: true })).toThrow(/targetRoot/);
  expect(() => targetRoot({ targetRoot: 1 })).toThrow(/targetRoot/);
  expect(() => targetRoot({ targetRoot: "" })).toThrow(/targetRoot/);
  expect(() => targetRoot({ targetRoot: "   " })).toThrow(/targetRoot/);
});
