import { expect, test } from "bun:test";
import { mayRemove } from "../src/dirty";

// The pure half of `remove`: whether a directory may be deleted, given
// opencode2's `force` and whatever the git probe reported. `undefined` is the
// probe's "unknown" (no metadata, a failed or timed-out git), and it must never
// allow a delete — that is the data loss issue #13 guards against.

test("force allows removal without consulting the change list", () => {
  expect(mayRemove({ force: true, uncommitted: ["a.txt"] })).toEqual({ remove: true });
});

test("force allows removal even when the probe reported unknown", () => {
  // The user confirmed; a probe that could not answer must not block the
  // delete they asked for.
  expect(mayRemove({ force: true, uncommitted: undefined })).toEqual({ remove: true });
});

test("an unknown change list refuses removal", () => {
  const decision = mayRemove({ force: false, uncommitted: undefined });
  expect(decision.remove).toBe(false);
  if (!decision.remove) {
    expect(decision.reason).toContain("could not be determined");
  }
});

test("a non-empty change list refuses removal and names the count", () => {
  const decision = mayRemove({ force: false, uncommitted: ["a.txt", "b.txt"] });
  expect(decision.remove).toBe(false);
  if (!decision.remove) {
    expect(decision.reason).toContain("2 uncommitted change(s)");
    expect(decision.reason).toContain("a.txt");
    expect(decision.reason).toContain("b.txt");
  }
});

test("the refusal names up to three example paths, not all of them", () => {
  const decision = mayRemove({
    force: false,
    uncommitted: ["a", "b", "c", "d", "e"],
  });
  expect(decision.remove).toBe(false);
  if (!decision.remove) {
    expect(decision.reason).toContain("5 uncommitted change(s)");
    expect(decision.reason).toContain("e.g. a, b, c");
    // The examples are cut at three, so the fourth path never appears. Assert
    // on the path-shaped token, not the bare letter `d` (which "uncommitted"
    // itself contains).
    expect(decision.reason).not.toContain(" d");
    expect(decision.reason).not.toContain("e)");
  }
});

test("an empty change list allows removal", () => {
  expect(mayRemove({ force: false, uncommitted: [] })).toEqual({ remove: true });
});
