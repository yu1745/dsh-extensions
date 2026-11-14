import { installFallbackSettings } from "./fallback-panel.js";
import { installNoWorkspace } from "./no-workspace-client.js";
import { installJevSettings } from "./jev-settings.js";
import { installOpenaiContextSettings } from "./openai-context-settings.js";
import React, { useState, useEffect, useSyncExternalStore } from "react";
import { TurnElapsed } from "./turn-elapsed.js";
const dockButtonStyle: any = {
  font: "inherit",
  fontSize: 12,
  color: "inherit",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "4px 8px",
  opacity: 0.75,
  textAlign: "left",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
};
function CodexFastToggle({
  api,
  directory,
  sessionId,
}: {
  api: any;
  directory: any;
  sessionId: string;
}) {
  const model: any = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot,
  );
  const codex = model.current?.provider === "openai-codex";
  const [mode, setMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!codex || busy) return;
    let alive = true;
    let pending = false;
    setMode(null);
    const read = async () => {
      if (pending) return;
      try {
        const r = await api.speed(sessionId);
        if (alive && !pending && r.ok) {
          setMode(r.value.mode);
          setError("");
        }
      } catch {
        if (alive) setError("无法读取 Fast 状态");
      }
    };
    void read();
    const timer = setInterval(read, 2000);
    const focus = () => void read();
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      pending = true;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [api, sessionId, codex, busy]);
  if (!codex) return null;
  const active = mode === "fast" || mode === "ultrafast";
  const label =
    error ||
    (mode === null
      ? "读取 Fast 状态"
      : `${mode === "ultrafast" ? "UltraFast" : "Fast"} ${active ? "已开启，点击关闭" : "已关闭，点击开启"}`);
  async function toggle() {
    setBusy(true);
    try {
      const r = await api.setFast(sessionId, !active);
      if (!r.ok) throw new Error(r.error?.message ?? "切换失败");
      setMode(r.value.mode);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="yu-codex-fast-toggle"
      role="switch"
      aria-checked={active}
      aria-label={label}
      title={label}
      disabled={busy || mode === null}
      onClick={toggle}
      style={{
        ...dockButtonStyle,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        order: 1000,
        marginLeft: "auto",
        flexShrink: 0,
        borderRadius: 8,
        padding: "5px 7px",
        background: active ? "rgba(196, 139, 22, 0.12)" : "transparent",
        color: active ? "#c48b16" : "inherit",
        opacity: active ? 1 : 0.5,
      }}
    >
      <style>{`
        [data-composer-dock]:has(.yu-codex-fast-toggle) > :has(.yu-codex-fast-toggle) { display: contents; }
      `}</style>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M13.4 3.2c.5-.6 1.4-.2 1.3.5l-.9 5.6h4.6c.7 0 1.1.8.6 1.3l-8.4 10.2c-.5.6-1.4.2-1.3-.5l.9-5.6H5.6c-.7 0-1.1-.8-.6-1.3L13.4 3.2Z" />
      </svg>
    </button>
  );
}
export const inject = [
  "slots",
  "remote",
  "sidebarRightTabs",
  "sidebarRight",
  "modelDirectories",
];
export async function apply(ctx: any) {
  try {
    await installNoWorkspace(ctx);
    installJevSettings(ctx);
    // 以下插件已取消注册，其前端 UI 一并移除（实现代码保留，仅不再挂载）：
    //   yu-model-menu      -> installModelMenu（模型菜单；它曾以 priority -10 覆盖原生
    //                         conversation.input.model 单槽，导致 DSH 原生模型菜单及其
    //                         conversation.input.model.options 子槽（智能体团队开关）被遮蔽，
    //                         故不再挂载，让原生菜单胜出。src/model-menu.tsx 保留备用。）
    //   yu-web-search      -> installSearchSettings（设置 → 网页搜索 / 搜索后端选择页）
    //   yu-model-fallback  -> installFallbackSettings
    //   yu-openai-windows  -> installOpenaiContextSettings
    //   yu-providers / yu-quota / yu-codex-fast
    //     -> remote 挂载（remoteInfo / providerRemoteInfo / codexAuthRemoteInfo）
    //        以及原 yuQuota 注入区块内的「额度与费用」页、会话计费、Codex Fast 开关与提供方登录面板。
    //   yu-worked-for      -> TurnElapsed ("Worked for {time}s")
    // 保留与上述插件无关的通用 UI：无工作区。
  } catch (error) {
    console.error("[dsh-extensions] client activation failed", error);
    throw error;
  }
}
