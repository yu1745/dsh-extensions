type Workspace = {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: readonly string[];
};
type WorkspaceSnapshot = { items: readonly Workspace[]; [key: string]: unknown };

/** Match only direct children created by this extension, never user projects. */
export function isIndependentWorkspace(workspace: Workspace, directory: string): boolean {
  const path = workspace.path.replace(/\\/g, "/");
  const root = directory.replace(/\\/g, "/").replace(/\/$/, "");
  const child = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";
  return /^chat-[^/]+$/.test(child) && /^不在工作区工作 · [a-zA-Z0-9]{6}$/.test(workspace.title);
}

/** Present one group while keeping every Host Workspace and Session header intact. */
export function groupIndependentWorkspaces<T extends WorkspaceSnapshot>(
  snapshot: T,
  directory: string,
  selectedBlankId?: string,
): T {
  const managed = snapshot.items.filter((item) => isIndependentWorkspace(item, directory));
  if (managed.length === 0) return snapshot;
  // Keep the key stable; the selected blank needs its *real* path for native recovery.
  const representative = managed.find((item) => selectedBlankId !== undefined && item.sessionIds.includes(selectedBlankId)) ?? managed[managed.length - 1];
  const ids = new Set(managed.map((item) => item.workspaceId));
  const sessionIds = [...new Set(managed.flatMap((item) => item.sessionIds))];
  let inserted = false;
  return {
    ...snapshot,
    items: snapshot.items.flatMap((item) => {
      if (!ids.has(item.workspaceId)) return [item];
      if (inserted) return [];
      inserted = true;
      return [{ ...representative, title: "不在工作区工作", sessionIds }];
    }),
  } as T;
}
