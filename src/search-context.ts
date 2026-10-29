import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir, readJson, writeJson } from "./state.js";
import {
  backends,
  getWebSearchBackend,
  type WebSearchBackend,
} from "./vendor/web-search/backend-config.js";

export type SearchOverride = { backend: WebSearchBackend; explicit: boolean };
const directory = join(dataDir, "search-backends");

function file(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
  return join(directory, `${id}.json`);
}
/**
 * A per-session override. Older releases wrote one for every session as it was
 * attached; those records carry no `explicit` flag and therefore keep following
 * the global default until the user switches that session with the command.
 */
export function searchOverride(id: string): SearchOverride | undefined {
  const saved = readJson<any>(file(id), {});
  if (!backends.includes(saved.backend)) return undefined;
  return { backend: saved.backend, explicit: saved.explicit === true };
}
export function explicitSearchBackend(
  id: string,
): WebSearchBackend | undefined {
  const override = searchOverride(id);
  return override?.explicit ? override.backend : undefined;
}
export function searchBackendFor(id: string): WebSearchBackend {
  return explicitSearchBackend(id) ?? getWebSearchBackend();
}
export function saveSearchBackend(id: string, backend: WebSearchBackend) {
  if (!backends.includes(backend)) throw new Error("Invalid search backend");
  writeJson(file(id), { backend, explicit: true });
}
export function clearSearchBackend(id: string) {
  rmSync(file(id), { force: true });
}
export function searchOverrides(): {
  sessionId: string;
  backend: WebSearchBackend;
}[] {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const sessionId = name.slice(0, -5);
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return [];
      const explicit = explicitSearchBackend(sessionId);
      return explicit ? [{ sessionId, backend: explicit }] : [];
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
export function clearSearchOverrides() {
  for (const { sessionId } of searchOverrides()) clearSearchBackend(sessionId);
}
