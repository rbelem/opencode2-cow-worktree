import { expect, test } from "bun:test";
import { fallbackPolicy, postCreateHooks, targetRoot } from "../src/config";

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

// --- hooks.postCreate (ticket 05) ---

test("absent options configure no hooks", () => {
  expect(postCreateHooks(undefined)).toEqual([]);
});

test("empty options configure no hooks", () => {
  expect(postCreateHooks({})).toEqual([]);
});

test("a hooks object without postCreate configures no hooks", () => {
  expect(postCreateHooks({ hooks: {} })).toEqual([]);
});

test("an empty postCreate list configures no hooks", () => {
  expect(postCreateHooks({ hooks: { postCreate: [] } })).toEqual([]);
});

test("a configured hook list is returned verbatim, in order", () => {
  const commands = ["npm install", "bun run generate"];
  expect(postCreateHooks({ hooks: { postCreate: commands } })).toEqual(commands);
});

test("a hooks value that is not an object fails loudly, naming the key", () => {
  expect(() => postCreateHooks({ hooks: "npm install" })).toThrow(/hooks/);
  expect(() => postCreateHooks({ hooks: ["npm install"] })).toThrow(/hooks/);
  expect(() => postCreateHooks({ hooks: null })).toThrow(/hooks/);
});

test("a non-array postCreate fails loudly, naming the key", () => {
  expect(() => postCreateHooks({ hooks: { postCreate: "npm install" } })).toThrow(
    /hooks\.postCreate/,
  );
  expect(() => postCreateHooks({ hooks: { postCreate: 7 } })).toThrow(/hooks\.postCreate/);
});

test("a non-string entry fails loudly, naming the key", () => {
  expect(() => postCreateHooks({ hooks: { postCreate: ["npm install", 42] } })).toThrow(
    /hooks\.postCreate/,
  );
  expect(() => postCreateHooks({ hooks: { postCreate: [null] } })).toThrow(/hooks\.postCreate/);
});

test("an empty or blank command fails loudly, naming the key", () => {
  expect(() => postCreateHooks({ hooks: { postCreate: [""] } })).toThrow(/hooks\.postCreate/);
  expect(() => postCreateHooks({ hooks: { postCreate: ["   "] } })).toThrow(/hooks\.postCreate/);
});

test("the option errors name the offending value", () => {
  expect(() => postCreateHooks({ hooks: "bogus" })).toThrow(/"bogus"/);
  expect(() => postCreateHooks({ hooks: { postCreate: "bogus" } })).toThrow(/"bogus"/);
  expect(() => postCreateHooks({ hooks: { postCreate: [1] } })).toThrow(/\[1\]/);
});
