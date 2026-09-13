/**
 * The badge decision for a worktree inventory, kept a pure function so it can
 * be tested without a TUI or a live server.
 *
 * Returns the literal `"cow"` when the inventory records `directory` — under
 * the same directory-identity rule the tool's attach flow applies, basename
 * narrowing then exact match then realpath with lexical fallback — with the
 * `cow` strategy id. Everything else — no match, an empty inventory, a `git`
 * entry, an entry with no strategy — yields `undefined`, which the caller
 * renders as nothing.
 *
 * The shared matcher (`inventoryEntryFor` in `src/tool.ts`) is the point: the
 * inventory may record the same directory through a different spelling (a
 * symlinked ancestor, a `..` segment), and an exact-string badge would go dark
 * for a location the tool happily attaches to. The row type is the upstream
 * `WorktreeInventoryEntry` rather than a local lookalike, so a schema change
 * surfaces here at compile time.
 */
import { inventoryEntryFor } from "./src/tool";
import type { WorktreeInventoryEntry } from "./types/opencode2-worktree";

export async function strategyBadge(
  entries: readonly WorktreeInventoryEntry[],
  directory: string,
): Promise<"cow" | undefined> {
  const match = await inventoryEntryFor(entries, directory);
  return match?.strategy === "cow" ? "cow" : undefined;
}
