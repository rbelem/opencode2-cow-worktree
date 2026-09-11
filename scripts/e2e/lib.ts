// SPDX-License-Identifier: MIT
/**
 * Helpers for the e2e dogfood harness.
 *
 * Kept separate from `harness.ts` so the run script reads as a sequence of
 * steps. Every filesystem mutation goes through `node:fs/promises`; this repo's
 * shell guard blocks `rm -rf`, and the harness must not depend on it anyway.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, link, writeFile, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const COW_ROOT = "/tmp/opencode";
export const NON_COW_ROOT = "/dev/shm";

export function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function git(repo: string, ...args: string[]): string {
  return run("git", ["-C", repo, ...args]);
}

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(COW_ROOT, "cow-e2e-"));
}

/** A temp directory on a specific root (e.g. a non-CoW filesystem like tmpfs). */
export async function tempRootUnder(root: string): Promise<string> {
  return mkdtemp(join(root, "cow-e2e-"));
}

export async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * A real scratch git repository to act as the source project: tracked files, an
 * ignored dependency directory, an ignored file, a relative symlink, a
 * hard link, a shared-named log the fan-out appends to, and an incompressible
 * blob so extent sharing is measurable.
 */
export async function makeSourceProject(project: string): Promise<void> {
  await mkdir(project, { recursive: true });
  git(project, "init", "-q");
  git(project, "config", "user.email", "e2e@example.com");
  git(project, "config", "user.name", "e2e");
  await writeFile(join(project, ".gitignore"), "node_modules/\n*.log\n");
  await writeFile(join(project, "tracked.txt"), "hello from source\n");
  await mkdir(join(project, "node_modules", "dep"), { recursive: true });
  await writeFile(join(project, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(join(project, "debug.log"), "ignored log line\n");
  await writeFile(join(project, "agent-log.txt"), "");
  await writeFile(join(project, "blob.bin"), randomBytes(8 * 1024 * 1024));
  await symlink("tracked.txt", join(project, "link-to-tracked"));
  await link(join(project, "tracked.txt"), join(project, "hardlink.txt"));
  await git(project, "add", "-A");
  await git(project, "commit", "-qm", "scratch source");
}

/** The throwaway config root and the env that isolates the server into it. */
export interface ConfigRoot {
  readonly root: string;
  readonly config: string;
  readonly project: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Installs the plugin by directory, which is what the loader requires: a
 * configured plugin target must be a directory whose `Host.resolve` finds an
 * `index`/`server` entrypoint. The repo's entry is `src/plugin.ts`, so the
 * directory re-exports it.
 */
export async function installPlugin(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "index.ts"),
    `export { default } from ${JSON.stringify(join(REPO_ROOT, "src", "plugin.ts"))};\n`,
  );
  return dir;
}

export async function makeConfigRoot(options?: {
  readonly password?: string;
}): Promise<ConfigRoot> {
  const root = await tempRoot();
  const config = join(root, "config", "opencode");
  const project = join(root, "project");
  for (const dir of [project, config, join(root, "data"), join(root, "state"), join(root, "cache")]) {
    await mkdir(dir, { recursive: true });
  }
  return {
    root,
    config,
    project,
    env: {
      ...process.env,
      HOME: root,
      OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG_DIR: config,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DB: join(root, "opencode.db"),
      OPENCODE_DISABLE_FILEWATCHER: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_PASSWORD: options?.password ?? "e2e-password",
    },
  };
}

/** Declares a configured plugin entry in the config root's `opencode.json`. */
export async function declarePlugin(
  config: ConfigRoot,
  dir: string,
  options: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(config.config, "opencode.json"),
    `${JSON.stringify({ plugins: [{ package: dir, options }] }, null, 2)}\n`,
  );
}

/** A minimal client for the v2 HTTP API, scoped to one location. */
export interface Api {
  readonly base: string;
  readonly auth: string;
  json(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }>;
}

export function makeApi(base: string, password: string, location: string): Api {
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const url = (path: string) => {
    const u = new URL(base + path);
    u.searchParams.set("location[directory]", location);
    return u;
  };
  return {
    base,
    auth,
    async json(method, path, body) {
      const response = await fetch(url(path), {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed, text };
    },
  };
}
