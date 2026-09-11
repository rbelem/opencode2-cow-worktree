import { expect, test } from "bun:test";
import { fallbackPolicy } from "../src/config";

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
