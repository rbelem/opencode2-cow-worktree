/**
 * The `remove_worktree` tool's decision logic: clean up a finished cow lane —
 * its directory *and* its inventory row together — without `rm -rf` and
 * without hand-editing opencode's SQLite.
 *
 * WHY the landed-ness guard lives here and not in `strategy.remove`: the
 * strategy's `remove` is also what opencode2's TUI drives, and its contract
 * there is only the dirty probe (issue #13). Changing what the TUI's remove
 * button does is not this tool's business, so the "has the lane's work
 * landed?" question is asked one layer up, where only agents are affected.
 * The strategy keeps its own dirty probe; this module adds the commit-level
 * question on top.
 *
 * The allow rule: a worktree may be removed when its HEAD has **landed** — it
 * is an ancestor of the landing ref (`origin/HEAD`, else `main`, else
 * `master`) — or when it is clean *and* holds no commits the landing ref
 * lacks. Anything else refuses, naming exactly what is unlanded, because an
 * agent cleaning up a lane must not destroy the only copy of finished-but-
 * unpushed work. A cow lane is a separate clone whose `origin/*` refs freeze
 * at clone time, so a would-be refusal first runs one `git fetch origin` and
 * re-judges on the fresh refs (issue #16); a pass on stale refs is already
 * sound, so the happy path never fetches, and a failed fetch keeps the
 * refusal while saying the verdict is stale-limited. An undetectable landing
 * ref also refuses: "cannot judge" is not "landed". `force: true` bypasses
 * the guard entirely — the human's confirmation, same meaning the TUI's
 * remove confirmation carries.
 *
 * `force` is then passed through **verbatim** to opencode2's
 * `ctx.worktree.remove`. When the guard passed because the tree is clean and
 * holds no unique commits, `force: false` lets the strategy run its own dirty
 * probe (which passes); at `force: true` the strategy skips it. Existing-
 * clone semantics — the quarantine dance, the identity capture — stay in the
 * strategy (`removal.ts`); none of that is re-implemented here.
 *
 * Identity and membership come from opencode2's worktree inventory (ADR 0003)
 * through the same matcher attach uses (`inventoryEntryFor`): a directory the
 * inventory does not know, or knows under another strategy, is not this
 * tool's to delete. A row whose directory is already gone is refused before
 * the guard: opencode2's DELETE route answers 400 "Worktree directory
 * unavailable" even at `force:true` until upstream candidate 8 lands
 * (`docs/research/upstream-issues.md`), so de-registering a dangling row is
 * impossible through the API and the tool must say so instead of failing with
 * a message that implies `force` would help.
 *
 * Every impure contact — the inventory, the removal, the directory check, git
 * itself — is injected (`RemoveWorktreeDeps`), so the decision table is
 * testable without opencode2 and without a git repository, exactly like
 * `SpawnWorkspaceDeps` in `./tool`.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { UncommittedChanges } from "./dirty";
import { inventoryEntryFor } from "./tool";
import type { WorktreeInventoryEntry } from "../types/opencode2-worktree";

/** How long one git invocation may run before the live binding gives up. */
const GIT_TIMEOUT_MS = 5_000;

const run = promisify(execFile);

/** The outcome of one git invocation the guard ran through the seam. */
export interface GitRun {
  /** The process exit code: 0 means the command answered affirmatively. */
  readonly code: number;
  /** Standard output, when the command produced any. */
  readonly stdout: string;
}

/**
 * The seams `removeWorktree` drives. Injected like `SpawnWorkspaceDeps` so the
 * refusal table is testable without opencode2, a filesystem, or git.
 */
export interface RemoveWorktreeDeps {
  /**
   * The worktree inventory (`ctx.worktree.list()`), the same seam attach and
   * `list_worktrees` read. The inventory, not a plugin-owned registry, is the
   * source of truth for "ours" (ADR 0003).
   */
  readonly listWorktrees: () => Promise<readonly WorktreeInventoryEntry[]>;
  /**
   * Removes a Worktree through opencode2's DELETE route
   * (`ctx.worktree.remove`). `force` is passed verbatim: `false` lets the
   * strategy's dirty probe run and pass on a clean tree, `true` skips it.
   */
  readonly removeWorktree: (directory: string, force: boolean) => Promise<void>;
  /**
   * Whether the worktree directory exists. The dangling-row pre-check asks
   * exactly one question — is the directory there — before any guard work.
   */
  readonly directoryExists: (directory: string) => Promise<boolean>;
  /**
   * Runs one git command inside the worktree. The landed-ness guard's only
   * contact with git: `symbolic-ref`, `rev-parse --verify --quiet`,
   * `merge-base --is-ancestor`, `rev-list --count`, and the refusal path's
   * `fetch origin` refresh. A non-zero exit is an answer ("no", "cannot"),
   * never an exception.
   */
  readonly runGit: (args: string[], cwd: string) => Promise<GitRun>;
  /**
   * Reports a worktree's uncommitted paths, or `undefined` when that cannot
   * be determined. The same probe the strategy's dirty guard uses
   * (`probeUncommitted` from `./uncommitted`); an unknown is treated as
   * dirty, exactly as `mayRemove` treats it.
   */
  readonly probeUncommitted: (directory: string) => Promise<UncommittedChanges>;
}

/** The tool's input, exactly as the JSON Schema declares it. */
export interface RemoveWorktreeInput {
  /** The worktree's basename, as `list_worktrees` reports it. */
  readonly name?: string;
  /** The worktree directory, as the inventory records it. */
  readonly directory?: string;
  /** Remove even when the worktree holds unlanded or uncommitted work. */
  readonly force?: boolean;
}

/** What a successful removal produced: the directory, and whether force ran. */
export interface RemoveWorktreeResult {
  /** The removed directory, verbatim as the inventory recorded it. */
  readonly directory: string;
  /** True when `force: true` bypassed the landed-ness guard. */
  readonly forced: boolean;
}

/**
 * Removes one cow worktree by name or directory, guarded against destroying
 * unlanded work. See the module doc for the why of each refusal.
 *
 * Order matters: the exactly-one-of selector check comes first (it is about
 * the input, not the world), then the inventory resolution (which decides
 * whether the target is ours at all), then the dangling-row pre-check (which
 * must precede the guard — the guard would run git in a directory that is not
 * there), then the landed-ness guard, and only then the removal itself.
 */
export async function removeWorktree(
  input: RemoveWorktreeInput,
  deps: RemoveWorktreeDeps,
): Promise<RemoveWorktreeResult> {
  const directory = await resolveTarget(input, deps);
  await assertDirectoryPresent(directory, deps);
  const forced = input.force === true;
  if (!forced) await assertLanded(directory, deps);
  await deps.removeWorktree(directory, forced);
  return { directory, forced };
}

/** One of the two selector shapes, after the exactly-one-of check. */
type Selector =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "name"; readonly name: string };

/**
 * Reads the input's selector: exactly one of `name`/`directory`, both
 * non-empty. An empty string is not a selector — the same rule attach applies
 * to `name` — so `{ name: "" }` refuses as "neither given" instead of
 * resolving to nothing surprising.
 */
function selectorOf(input: RemoveWorktreeInput): Selector {
  const name = typeof input.name === "string" && input.name.length > 0 ? input.name : undefined;
  const directory =
    typeof input.directory === "string" && input.directory.length > 0
      ? input.directory
      : undefined;
  if (name !== undefined && directory !== undefined) {
    throw new Error(
      'remove_worktree takes exactly one of "name" or "directory", not both: pass the ' +
        "worktree's basename from list_worktrees, or its directory as the inventory " +
        "records it — both were given.",
    );
  }
  if (name === undefined && directory === undefined) {
    throw new Error(
      'remove_worktree takes exactly one of "name" or "directory": pass the worktree\'s ' +
        "basename from list_worktrees, or its directory as the inventory records it — " +
        "neither was given.",
    );
  }
  return name !== undefined
    ? { kind: "name", name }
    : { kind: "directory", directory: directory! };
}

/**
 * Resolves the input's selector to the directory the inventory records, or
 * refuses: an unknown directory as Foreign, a non-cow row as foreign
 * strategy, an unknown or ambiguous name as a listing/ambiguity error.
 */
async function resolveTarget(
  input: RemoveWorktreeInput,
  deps: RemoveWorktreeDeps,
): Promise<string> {
  const selector = selectorOf(input);
  const entries = await deps.listWorktrees();
  return selector.kind === "directory"
    ? resolveByDirectory(entries, selector.directory)
    : resolveByName(entries, selector.name);
}

/**
 * The directory selector: the same identity matcher attach uses
 * (`inventoryEntryFor` — basename, exact string, then realpath/lexical
 * normalization), so a worktree list_worktrees reports is removable under the
 * spelling that report used. The removal targets the inventory-recorded
 * spelling: that is the path opencode2's record holds.
 */
async function resolveByDirectory(
  entries: readonly WorktreeInventoryEntry[],
  directory: string,
): Promise<string> {
  const entry = await inventoryEntryFor(entries, directory);
  if (entry === undefined) throw foreignWorktreeRemovalError(directory);
  if (entry.strategy !== "cow") {
    throw foreignStrategyRemovalError(directory, entry.strategy);
  }
  return entry.directory;
}

/**
 * The name selector: the basename of a `cow` inventory row. Non-cow rows are
 * filtered out first — a name can only ever resolve to a cow worktree, so a
 * `git`-strategy row under the same basename is invisible to name lookups,
 * not a foreign-strategy refusal. Zero matches lists what does exist; more
 * than one names every candidate and asks for the directory.
 */
function resolveByName(
  entries: readonly WorktreeInventoryEntry[],
  name: string,
): string {
  const cow = entries.filter((entry) => entry.strategy === "cow");
  const matches = cow.filter((entry) => basename(entry.directory) === name);
  if (matches.length === 0) throw unknownNameError(name, cow);
  if (matches.length > 1) throw ambiguousNameError(name, matches);
  return matches[0]!.directory;
}

/**
 * The dangling-row pre-check: a row whose directory is gone cannot be
 * de-registered through the API at all — opencode2's DELETE route answers
 * 400 "Worktree directory unavailable" even at `force:true` until upstream
 * candidate 8 lands. Refusing here names the real obstacle; letting the call
 * reach the API would surface that 400 as if `force` had not been tried.
 */
async function assertDirectoryPresent(
  directory: string,
  deps: RemoveWorktreeDeps,
): Promise<void> {
  if (await deps.directoryExists(directory)) return;
  throw danglingRowError(directory);
}

/**
 * The landed-ness guard, applied only when the caller did not force. It
 * refuses while the worktree holds unlanded work and otherwise lets the
 * removal proceed. Every sub-answer is fail-closed: an undetectable landing
 * ref and an undeterminable dirty state both refuse, because "cannot judge"
 * must never mean "safe to delete".
 */
async function assertLanded(
  directory: string,
  deps: RemoveWorktreeDeps,
): Promise<void> {
  const landingRef = await detectLandingRef(directory, deps);
  if (landingRef === undefined) throw landingRefUnknownError(directory);
  let check = await landingCheck(directory, landingRef, deps);
  let refreshFailed = false;
  if (!landed(check)) {
    // A cow lane is a separate clone whose origin/<branch> refs freeze at
    // clone time, so work that landed on the remote afterwards (a merged
    // PR) looks unlanded here (issue #16). Refresh once and re-judge before
    // refusing; a pass on stale refs is already sound, so the fetch only
    // ever runs on the refusal path.
    const fetched = await deps.runGit(["fetch", "origin"], directory);
    if (fetched.code === 0) {
      check = await landingCheck(directory, landingRef, deps);
    } else {
      refreshFailed = true;
    }
  }
  if (landed(check)) return;
  throw unlandedError(directory, landingRef, check, refreshFailed);
}

/** The guard's allow rule over one probe set. */
function landed(check: LandingCheck): boolean {
  const clean = check.uncommitted !== undefined && check.uncommitted.length === 0;
  return check.landed || (clean && check.uniqueCommits === 0);
}

/** What the guard learned about one worktree's landed-ness. */
interface LandingCheck {
  /** `git merge-base --is-ancestor HEAD <ref>` exited 0. */
  readonly landed: boolean;
  /** `git rev-list --count <ref>..HEAD`, or `undefined` when it failed. */
  readonly uniqueCommits: number | undefined;
  /** The dirty probe's answer; `undefined` means it could not tell. */
  readonly uncommitted: UncommittedChanges;
}

/** Runs the guard's three probes — ancestry, unique-commit count, dirty state. */
async function landingCheck(
  directory: string,
  landingRef: string,
  deps: RemoveWorktreeDeps,
): Promise<LandingCheck> {
  const ancestor = await deps.runGit(
    ["merge-base", "--is-ancestor", "HEAD", landingRef],
    directory,
  );
  const counted = await deps.runGit(
    ["rev-list", "--count", `${landingRef}..HEAD`],
    directory,
  );
  const uncommitted = await deps.probeUncommitted(directory);
  return {
    landed: ancestor.code === 0,
    uniqueCommits: counted.code === 0 ? parseCount(counted.stdout) : undefined,
    uncommitted,
  };
}

/** A `rev-list --count` answer, or `undefined` when it is not a number. */
function parseCount(stdout: string): number | undefined {
  const count = Number.parseInt(stdout.trim(), 10);
  return Number.isNaN(count) ? undefined : count;
}

/**
 * The worktree's landing ref: the first of `origin/HEAD` (resolved through
 * `git symbolic-ref`, trimmed to `origin/<branch>`), `main`, and `master`
 * that `git rev-parse --verify --quiet` confirms. `undefined` when none
 * resolves — which refuses, because landed-ness cannot be judged.
 */
async function detectLandingRef(
  directory: string,
  deps: RemoveWorktreeDeps,
): Promise<string | undefined> {
  const fromOriginHead = await originHeadRef(directory, deps);
  if (fromOriginHead !== undefined && (await refResolves(fromOriginHead, directory, deps))) {
    return fromOriginHead;
  }
  for (const candidate of ["main", "master"]) {
    if (await refResolves(candidate, directory, deps)) return candidate;
  }
  return undefined;
}

/** The `origin/<branch>` ref `origin/HEAD` points at, when it answers one. */
async function originHeadRef(
  directory: string,
  deps: RemoveWorktreeDeps,
): Promise<string | undefined> {
  const answer = await deps.runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    directory,
  );
  if (answer.code !== 0) return undefined;
  const ref = answer.stdout.trim();
  // A symbolic-ref answer outside refs/remotes/ is not a remote branch this
  // guard can name; treat it as no answer rather than passing it on.
  return ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : undefined;
}

/** Whether `git rev-parse --verify --quiet <ref>` confirms the ref exists. */
async function refResolves(
  ref: string,
  directory: string,
  deps: RemoveWorktreeDeps,
): Promise<boolean> {
  const answer = await deps.runGit(["rev-parse", "--verify", "--quiet", ref], directory);
  return answer.code === 0;
}

/**
 * The unlanded refusal, naming exactly what has not landed. A failed
 * `fetch` refresh is named too, so the operator knows the counts came from
 * the refs frozen at clone time.
 */
function unlandedError(
  directory: string,
  landingRef: string,
  check: LandingCheck,
  refreshFailed: boolean,
): Error {
  const stale =
    "A `git fetch origin` refresh failed, so this verdict used the remote " +
    "refs frozen at clone time. ";
  return new Error(
    `refusing to remove ${directory}: it holds work that has not landed on ` +
      `${landingRef} — ${describeUnlanded(check.uniqueCommits, check.uncommitted)}. ` +
      (refreshFailed ? stale : "") +
      "Re-run with force to remove anyway.",
  );
}

/** The counts half of the unlanded refusal; unknowns are named as unknown. */
function describeUnlanded(
  uniqueCommits: number | undefined,
  uncommitted: UncommittedChanges,
): string {
  const commits =
    uniqueCommits === undefined
      ? "an unknown number of unique commit(s) (the git probe failed)"
      : `${uniqueCommits} unique commit(s)`;
  const files =
    uncommitted === undefined
      ? "an unknown number of uncommitted file(s) (the probe could not answer)"
      : `${uncommitted.length} uncommitted file(s)`;
  return `${commits} and ${files}`;
}

/** The refusal for an undetectable landing ref; force still overrides. */
function landingRefUnknownError(directory: string): Error {
  return new Error(
    `refusing to remove ${directory}: the landing ref could not be determined — ` +
      "none of refs/remotes/origin/HEAD (via git symbolic-ref), main, or master " +
      "resolves in this worktree, so landed-ness cannot be judged. " +
      "Re-run with force to remove anyway.",
  );
}

/** The refusal for a directory the inventory does not know at all. */
function foreignWorktreeRemovalError(directory: string): Error {
  return new Error(
    `refusing to remove ${directory}: opencode2's worktree inventory has no entry ` +
      "for it, so it is not a worktree this strategy materialized (a Foreign " +
      "worktree). remove_worktree removes only worktrees its cow strategy " +
      "created; if nothing needs what is inside, remove the directory by hand.",
  );
}

/** The refusal for an inventory entry naming a strategy other than `cow`. */
function foreignStrategyRemovalError(
  directory: string,
  strategy: string | undefined,
): Error {
  const described = strategy === undefined ? "no strategy" : `"${strategy}"`;
  return new Error(
    `refusing to remove ${directory}: the worktree inventory records it with ` +
      `${described}, not "cow" — remove_worktree will not remove a Worktree ` +
      "another strategy materialized. Remove it through opencode2 or by hand.",
  );
}

/**
 * The refusal for a row whose directory is gone: the API cannot clear it
 * until upstream candidate 8 ("Worktree.remove resolves the real path before
 * reading the record") lands, so the refusal names that instead of letting a
 * 400 "Worktree directory unavailable" imply that `force` was not tried.
 */
function danglingRowError(directory: string): Error {
  return new Error(
    `refusing to remove ${directory}: the worktree directory no longer exists, so ` +
      "the inventory row is dangling and cannot be de-registered through the API " +
      'until upstream candidate 8 ("Worktree.remove resolves the real path before ' +
      'reading the record") lands — the DELETE route answers 400 "Worktree directory ' +
      "unavailable\" even at force:true. See docs/research/upstream-issues.md; " +
      "until then, clearing the row means editing opencode.db by hand.",
  );
}

/** The refusal for a name no cow row carries, listing the rows that exist. */
function unknownNameError(
  name: string,
  cow: readonly WorktreeInventoryEntry[],
): Error {
  const known =
    cow.length === 0
      ? "this location's inventory has no cow worktrees"
      : `known cow worktree(s): ${cow.map((entry) => basename(entry.directory)).join(", ")}`;
  return new Error(
    `no cow worktree named ${JSON.stringify(name)}: ${known}. ` +
      "Run list_worktrees to see this location's cow worktrees.",
  );
}

/** The refusal for a name several cow rows carry; the directory disambiguates. */
function ambiguousNameError(
  name: string,
  matches: readonly WorktreeInventoryEntry[],
): Error {
  return new Error(
    `the name ${JSON.stringify(name)} is ambiguous: ${matches.length} cow worktrees ` +
      `share that basename — ${matches.map((entry) => entry.directory).join(", ")}. ` +
      "Pass the full directory instead.",
  );
}

/**
 * The live `runGit` binding: one git invocation via `execFile` — no shell, no
 * inherited prompt — with the same hygiene `probeUncommitted` uses. Declared
 * total like the guard's other answers: every failure (non-zero exit,
 * timeout, no git on the machine) resolves to a non-zero code, which each
 * caller reads as "no"/"cannot". An exit code the error object carries is
 * kept so a signal kill and a plain refusal are at least distinguishable in
 * principle; anything unreadable is 1.
 */
export async function runGit(args: string[], cwd: string): Promise<GitRun> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_PAGER: "cat", GIT_EDITOR: "true", CI: "1" },
    });
    return { code: 0, stdout };
  } catch (cause) {
    return { code: exitCodeOf(cause), stdout: "" };
  }
}

/** The exit code an execFile failure carries, when it carries one. */
function exitCodeOf(cause: unknown): number {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "number") return code;
  }
  return 1;
}
