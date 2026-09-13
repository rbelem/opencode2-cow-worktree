#!/usr/bin/env bun
/**
 * Coverage gate: every module this repo ships must be executed by the unit
 * suite at 100% of its lines.
 *
 * `bun test --coverage` alone cannot express that. It leaves two holes:
 *
 *   - It reports only files a test actually loaded. A module no test imports is
 *     absent from the report, not 0% — invisible. That is how `src/index.ts` and
 *     `tui.tsx` sat at zero.
 *   - Bun 1.4.2 has no `--coverage-threshold` flag and ignores the `bunfig.toml`
 *     `coverageThreshold` key, so a run cannot fail on coverage by itself.
 *
 * So this reads the lcov report, refuses to pass when a gated file is missing
 * from it, and requires every gated file to be line-complete. Bun measures; the
 * policy lives here.
 *
 * Gated: `src/**`, the two root plugin modules (`tui.tsx`,
 * `strategy-badge.ts`), and the APFS verification tooling under
 * `scripts/verify-apfs/`.
 *
 * Lines are checked; a per-file exclusion list (NOT_HITTABLE below) may excuse
 * a line that provably cannot be hit. No hittable line is ever excluded on
 * convenience: an entry there is a Bun lcov artifact, established by an
 * isolated reproduction, and the gate itself deletes any entry that starts
 * reporting hits.
 *
 * Functions are checked as well as lines, but Bun's per-function counting is
 * itself unreliable, so a file may declare how many of its reported functions
 * are real. See `FUNCTION_UNDERCOUNT` for the reproduction.
 *
 * Not gated, on purpose: the development harnesses (`scripts/e2e/**`,
 * `scripts/dogfood-install-check.ts`, this file) and the APFS verify CLI
 * entrypoint (`scripts/verify-apfs/verify-apfs.ts`). They are driven by hand or
 * by CI, not by the unit suite, and covering them would measure the harness
 * rather than the plugin. The decision modules they call are gated.
 */
import { Glob } from "bun";
import { relative, resolve } from "node:path";

const LCOV = resolve(process.argv[2] ?? "coverage/lcov.info");
const root = process.cwd();

/**
 * Type-only modules compile to no runtime code, so coverage can never report a
 * line for them. They are not gaps.
 */
const NO_RUNTIME_CODE = new Set(["src/mechanism.ts"]);

/**
 * Functions Bun's lcov reports that do not exist, keyed
 * `relative/path.ts` -> phantom count.
 *
 * Bun's function counter breaks on two constructs, reproduced in isolation:
 *
 *   - A function whose body is a single expression on the declaration line
 *     (e.g. `export function f(x) { return g(x) }`) is counted as declared but
 *     never hit, even though its line is hit. The arrow in `src/clone.ts:66`
 *     (`() => lstat(from)`) is exactly this shape.
 *   - A nested arrow inside an outer function is counted as an additional
 *     function, so a module can report more functions than it declares.
 *
 * Neither can be satisfied by a test, because no test can make Bun record a hit
 * for a function it mis-counts. The declaration here is bounded on both sides:
 * it fails if the reported count changes at all, so a real regression — or a
 * fixed Bun — surfaces instead of being absorbed.
 */
const FUNCTION_UNDERCOUNT: Readonly<Record<string, number>> = {
  "src/clone.ts": 1,
};

/**
 * CLI entrypoints, excluded for the same reason as the development harnesses
 * below: they are driven by a human or by CI on real APFS hardware, and their
 * 500-line body is a sequence of filesystem and `df` shell calls rather than a
 * decision surface. The decision modules they call — `extents.ts` and
 * `logic.ts` — are gated.
 */
const NOT_GATED = new Set(["scripts/verify-apfs/verify-apfs.ts"]);

/**
 * Gated lines Bun's lcov reports as unreachable that provably cannot be hit.
 * Keyed `relative/path.ts:line`. Keep tiny and justified.
 *
 * Empty since the attach work (.scratch ticket 01): it held the closing brace of
 * `nearestExistingDevice`'s `for (;;)` (an unconditional loop whose only exits
 * are `return`s), which Bun used to mark unreachable. The same construct now
 * reports a hit under the current binary, so per this gate's own rule the
 * entry was deleted instead of being re-pinned. If the artifact returns, the
 * gate will name the line again.
 */
const NOT_HITTABLE = new Set<string>([]);

const GATED_GLOBS = [
  "src/**/*.ts",
  "src/**/*.tsx",
  "tui.tsx",
  "strategy-badge.ts",
  "scripts/verify-apfs/**/*.ts",
];

/** Test files are not shipped code; they are the instrument making the measurement. */
const IS_TEST = /(^|\/)test\/|\.test\.tsx?$/;

interface FileCoverage {
  readonly path: string;
  linesFound: number;
  linesHit: number;
  readonly missed: number[];
  functionsFound: number;
  functionsHit: number;
}

function gatedFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of GATED_GLOBS) {
    for (const match of new Glob(pattern).scanSync({ cwd: root, dot: false })) {
      const path = match.replaceAll("\\", "/");
      if (IS_TEST.test(path) || NO_RUNTIME_CODE.has(path) || NOT_GATED.has(path)) continue;
      files.add(path);
    }
  }
  return [...files].sort();
}

function parseLcov(text: string): Map<string, FileCoverage> {
  const records = new Map<string, FileCoverage>();
  let current: FileCoverage | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = relative(root, resolve(line.slice(3))).replaceAll("\\", "/");
      current = { path, linesFound: 0, linesHit: 0, missed: [], functionsFound: 0, functionsHit: 0 };
      records.set(path, current);
    } else if (current === undefined) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [lineNumber, hits] = line.slice(3).split(",");
      if (hits === "0" && lineNumber !== undefined) current.missed.push(Number(lineNumber));
    } else if (line.startsWith("LF:")) {
      current.linesFound = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      current.linesHit = Number(line.slice(3));
    } else if (line.startsWith("FNF:")) {
      current.functionsFound = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      current.functionsHit = Number(line.slice(4));
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return records;
}

const records = parseLcov(await Bun.file(LCOV).text());
const expected = gatedFiles();
const failures: string[] = [];

// An exclusion must not outlive what it excuses. If a previously unreachable
// line starts being hit, the entry is dead weight hiding a real report, so it
// is surfaced rather than allowed to sit there.
for (const key of NOT_HITTABLE) {
  const separator = key.lastIndexOf(":");
  const path = key.slice(0, separator);
  const line = Number(key.slice(separator + 1));
  if (!expected.includes(path)) {
    failures.push(`  NOT_HITTABLE entry names a file that is not gated: ${key}`);
    continue;
  }
  const record = records.get(path);
  if (record !== undefined && !record.missed.includes(line)) {
    failures.push(`  NOT_HITTABLE entry is no longer unreachable: ${key}. Delete it.`);
  }
}

const uninstrumented = expected.filter((path) => {
  const record = records.get(path);
  return record === undefined || record.linesFound === 0;
});
if (uninstrumented.length > 0) {
  failures.push(
    `${uninstrumented.length} gated file(s) were never loaded by any test — no test imports them:`,
    ...uninstrumented.map((path) => `  ${path}`),
  );
}

for (const path of expected) {
  const record = records.get(path);
  if (record === undefined || record.linesFound === 0) continue;

  // Functions as well as lines. A module can keep every line covered while a
  // whole function in it is never called (its body is one line, or it is only
  // referenced as a default argument), and that is the shape a seam refactor
  // introduces.
  const phantom = FUNCTION_UNDERCOUNT[path] ?? 0;
  const functionsExpected = record.functionsFound - phantom;
  if (record.functionsHit !== functionsExpected) {
    failures.push(
      `  ${path}: ${record.functionsHit}/${record.functionsFound} functions` +
        (phantom > 0 ? ` (declared ${phantom} phantom, so expected ${functionsExpected})` : ""),
    );
  }

  const missed = record.missed.filter((line) => !NOT_HITTABLE.has(`${path}:${line}`));
  if (missed.length === 0) continue;
  failures.push(
    `  ${path}: ${record.linesHit}/${record.linesFound} lines (missed ${missed.join(", ")})`,
  );
}

if (failures.length > 0) {
  console.error(`coverage gate failed (${LCOV}):`);
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`coverage gate passed: ${expected.length} gated files at 100% lines.`);
