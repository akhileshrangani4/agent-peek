// src/skills/discover.ts
//
// The default project survey: which repositories to look in for project-local skills.
// Kept apart from `projects.ts` (pure path logic) because this half reads the usage
// index, and callers without an index still want the pure half.
import { queryUsage } from "../usage/query.js";
import type { UsageStore } from "../usage/store.js";
import { projectRootsFromCwds, PROJECT_SCAN_LIMIT } from "./projects.js";
import type { ProjectDiscovery } from "./projects.js";

/**
 * Repositories peek has recorded work in, most recent first, collapsed to git roots.
 *
 * On by default rather than behind a flag: a report that silently omits real usage
 * unless the user knows to ask for it is what made this necessary in the first place.
 * The cap is surfaced by the caller when it bites, the same way `truncated` is.
 */
export function discoverProjects(
  store: UsageStore,
  limit = PROJECT_SCAN_LIMIT,
): ProjectDiscovery {
  const rows = queryUsage(store, { groupBy: ["cwd"] });
  const cwds = rows
    .filter((r) => r.cwd)
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
    .map((r) => r.cwd as string);
  return projectRootsFromCwds(cwds, limit);
}
