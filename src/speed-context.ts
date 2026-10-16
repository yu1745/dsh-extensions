import { join } from "node:path";
import { dataDir, readJson, writeJson } from "./state.js";
export type Speed = "standard" | "fast" | "ultrafast";
let owners = 0;
export function activateSpeedModes() {
  owners++;
  return () => {
    owners = Math.max(0, owners - 1);
  };
}
function file(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
  return join(dataDir, "speeds", `${id}.json`);
}
export function speedOf(id?: string): Speed {
  if (!id) return "standard";
  const v = readJson<any>(file(id), {}).mode;
  return v === "fast" || v === "ultrafast" ? v : "standard";
}
export function setSpeed(id: string, mode: Speed) {
  writeJson(file(id), { mode });
}
export function inheritSpeed(id: string, parent?: string) {
  if (parent && readJson(file(id), null) === null)
    setSpeed(id, speedOf(parent));
}
export function codexServiceOptions(options: any) {
  if (!owners || options.provider !== "openai-codex") return {};
  const mode = speedOf(options.sessionId);
  return mode === "standard"
    ? {}
    : { serviceTier: mode === "fast" ? "priority" : "ultrafast" };
}
