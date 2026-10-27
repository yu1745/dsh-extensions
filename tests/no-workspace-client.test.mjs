import test from "node:test";
import assert from "node:assert/strict";
import { installNoWorkspace } from "../lib/no-workspace-client.js";
import { groupIndependentWorkspaces } from "../lib/no-workspace-group.js";

const root = "/tmp/dsh-independent-chats";
const child = (name, id, sessionIds = []) => ({
  workspaceId: id, path: `${root}/chat-${name}`, title: `不在工作区工作 · ${name}`,
  sessionIds, createdAt: "2026-01-01T00:00:00Z",
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("only extension workspaces fold into one group without changing Host records", () => {
  const first = child("abc123", "one", ["s1"]);
  const second = child("def456", "two", ["s2"]);
  const project = { workspaceId: "project", path: "/work/project", title: "Project", sessionIds: ["p"] };
  const forged = { ...child("ghi789", "forged", ["f"]), path: "/work/chat-ghi789" };
  const source = { items: [second, project, first, forged], phase: "ready" };
  const projected = groupIndependentWorkspaces(source, root);
  assert.deepEqual(projected.items.map((item) => item.workspaceId), ["one", "project", "forged"]);
  assert.equal(projected.items[0].title, "不在工作区工作");
  assert.deepEqual(projected.items[0].sessionIds, ["s2", "s1"]);
  assert.equal(projected.items[0].path, first.path);
  assert.deepEqual(source.items, [second, project, first, forged]);
  assert.equal(groupIndependentWorkspaces(source, root, "s2").items[0].path, second.path);
});

test("new conversations fold together, explicit projects stay native, and unload restores methods", async () => {
  const calls = [];
  let onDispose;
  let listener;
  const items = [child("abc123", "old", ["old-session"]), child("def456", "older", ["other-session"])];
  const snapshots = () => ({ items, phase: "ready" });
  const list = {
    getSnapshot: snapshots,
    subscribe: (callback) => { listener = callback; return () => { listener = undefined; }; },
    invalidate: () => listener?.(),
  };
  const originalStart = function (id, options) { calls.push({ kind: "start", id, options, visible: list.getSnapshot().items.map((item) => item.workspaceId) }); };
  const originalOpen = function (id, beforeOpen, options) { calls.push({ kind: "open", id, options, visible: list.getSnapshot().items.map((item) => item.workspaceId) }); };
  const uiWorkspace = { startSession: originalStart, openWorkspace: originalOpen,
    selection: { getSnapshot: () => ({ sessionId: "other-session" }) } };
  const workspaces = { list, rename: async () => {}, delete: async () => {}, insertSessionBefore: async () => {} };
  const ready = {
    uiWorkspace, workspaces,
    sessions: { list: { getSnapshot: () => ({ byId: { "other-session": { blank: true } } }) } },
    remote: { yuNoWorkspace: {
      base: async () => ({ ok: true, value: { directory: root } }),
      create: async () => ({ ok: true, value: { workspaceId: "fresh" } }),
    } },
    on: (event, callback) => { assert.equal(event, "dispose"); onDispose = callback; },
  };
  await installNoWorkspace({ remote: { $mount: async () => {} }, inject: (_, callback) => callback(ready) });
  await flush();
  assert.deepEqual(list.getSnapshot().items.map((item) => item.workspaceId), ["older"]);
  assert.equal(list.getSnapshot().items[0].path, items[1].path);
  uiWorkspace.startSession("project", { agentPreset: "ptc" });
  assert.equal(calls[0].id, "project");
  uiWorkspace.startSession("older");
  await flush();
  items.unshift(child("xyz987", "fresh"));
  listener();
  await flush();
  assert.equal(calls[1].id, "fresh");
  assert.deepEqual(calls[1].visible, ["fresh", "old", "older"]); // native lookup sees real rows
  assert.equal(list.getSnapshot().items.length, 1);
  await uiWorkspace.openWorkspace("older", undefined, { agentPreset: "ptc" });
  assert.equal(calls[2].kind, "open");
  assert.equal(calls[2].id, "fresh");
  assert.equal(calls[2].options.agentPreset, "ptc");
  await uiWorkspace.openWorkspace("project");
  assert.equal(calls[3].id, "project");
  await assert.rejects(workspaces.delete("older"), /不能整体删除/);
  onDispose();
  assert.equal(uiWorkspace.startSession, originalStart);
  assert.equal(uiWorkspace.openWorkspace, originalOpen);
  assert.equal(list.getSnapshot, snapshots);
  assert.equal(list.getSnapshot().items.length, 3);
});
