import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
export const dataDir = join(
  process.env.DSH_HOME || join(homedir(), ".dsh"),
  "extensions",
  "yu1745",
);
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
export const settingsFile = join(dataDir, "settings.json");
export function settings() {
  return readJson<Record<string, any>>(settingsFile, {});
}
export function updateSettings(patch: Record<string, any>) {
  writeJson(settingsFile, { ...settings(), ...patch });
}
