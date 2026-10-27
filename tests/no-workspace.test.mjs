import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIndependentWorkspace } from "../lib/no-workspace.js";

test("new chats receive separate existing workspace directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-no-workspace-test-"));
  const paths = [];
  const registry = {
    async create(path, title) {
      assert.match(title, /^不在工作区工作 · [a-zA-Z0-9]{6}$/);
      assert.equal((await stat(path)).isDirectory(), true);
      paths.push(path);
      return { id: `workspace-${paths.length}` };
    },
  };
  try {
    const directory = join(root, "default", "chats");
    const [one, two] = await Promise.all([
      createIndependentWorkspace(directory, registry),
      createIndependentWorkspace(directory, registry),
    ]);
    assert.notEqual(one.workspaceId, two.workspaceId);
    assert.notEqual(paths[0], paths[1]);
    assert.ok(paths.every((path) => path.startsWith(`${directory}/chat-`)));
    assert.equal((await readdir(directory)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
