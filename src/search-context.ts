import { join } from "node:path";
import { dataDir, readJson, writeJson } from "./state.js";
import {
  backends,
  getWebSearchBackend,
  type WebSearchBackend,
} from "./vendor/web-search/backend-config.js";

function file(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
  return join(dataDir, "search-backends", `${id}.json`);
}
export function savedSearchBackend(id: string): WebSearchBackend | undefined {
  const backend = readJson<any>(file(id), {}).backend;
  return backends.includes(backend) ? backend : undefined;
}
export function searchBackendFor(id: string): WebSearchBackend {
  return savedSearchBackend(id) ?? getWebSearchBackend();
}
export function saveSearchBackend(id: string, backend: WebSearchBackend) {
  if (!backends.includes(backend)) throw new Error("Invalid search backend");
  writeJson(file(id), { backend });
}
