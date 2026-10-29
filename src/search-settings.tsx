import React, { useEffect, useState } from "react";
import { searchRemoteInfo } from "./search-remote.js";

type Backend = {
  id: string;
  name: string;
  detail: string;
};

/** Order and copy mirror the `/websearch-backend` candidates. */
export const searchBackendOptions: Backend[] = [
  {
    id: "google",
    name: "Google · Antigravity",
    detail: "Gemini 实时检索，原生支持 site:、引号、after: 等搜索语法",
  },
  {
    id: "openai",
    name: "OpenAI · Codex",
    detail: "Codex Responses API 实时检索，支持搜索语法",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    detail: "Anthropic 协议原生 web_search 工具",
  },
  {
    id: "minimax",
    name: "MiniMax",
    detail: "Coding Plan 快速代码与工程检索",
  },
  {
    id: "zai",
    name: "ZAI · 智谱",
    detail: "BigModel 原生 MCP，支持地域、时效与域名过滤",
  },
];

const css = `
.yu-search{max-width:820px;margin:0 auto;padding:28px 24px 48px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.yu-search *{box-sizing:border-box}
.yu-search h2{font-size:21px;font-weight:600;letter-spacing:-.4px;margin:0 0 8px}
.yu-search h3{font-size:15px;margin:26px 0 8px;font-weight:600}
.yu-search p{margin:6px 0 16px}
.yu-search small,.yu-search .muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.yu-search button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#ddd);background:var(--dsw-alias-bg-base,transparent);border-radius:7px;padding:5px 10px;cursor:pointer}
.yu-search button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8881)}
.yu-search button:active:not(:disabled){transform:scale(.98)}
.yu-search button:disabled{opacity:.4;cursor:default}
.yu-search :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#5684d4);outline-offset:2px}
.yu-search .choice{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:9px;margin-bottom:8px;cursor:pointer}
.yu-search .choice:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}
.yu-search .choice[data-active=true]{border-color:var(--dsw-alias-label-primary,#333);box-shadow:inset 0 0 0 1px var(--dsw-alias-label-primary,#333)}
.yu-search input[type=radio]{margin-top:4px;width:15px;height:15px;flex:none;accent-color:var(--dsw-alias-label-primary,#333)}
.yu-search .choice-name{display:block;font-weight:500}
.yu-search .choice-id{font-variant-numeric:tabular-nums}
.yu-search .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0 6px}
.yu-search .save{background:var(--dsw-alias-label-primary,#333);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.yu-search .notice{font-size:12px;min-height:20px;margin:8px 0;color:var(--dsw-alias-label-tertiary)}
.yu-search .error{color:var(--dsw-alias-state-error-primary,#b43c30);font-size:13px;margin:10px 0}
.yu-search .empty{padding:18px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l1,#ddd);border-radius:10px;color:var(--dsw-alias-label-tertiary)}
.yu-search .row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-top:1px solid var(--dsw-alias-border-l1,#ddd)}
.yu-search .row-name{flex:1;min-width:0;overflow-wrap:anywhere}
.yu-search .row-name strong{font-size:13px;font-weight:500}
.yu-search .row-name small{display:block}
@media(max-width:600px){.yu-search{padding:20px 14px}}
`;

export function WebSearchSettings({ api }: { api: any }) {
  const [state, setState] = useState<any>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((r: any) => {
        if (!alive) return;
        if (!r.ok) throw new Error(r.error?.message ?? "读取失败");
        setState(r.value);
        setDraft(r.value.defaultBackend);
      })
      .catch((e: any) => {
        if (alive) setError(e.message ?? "读取失败");
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const options = state
    ? searchBackendOptions.filter((o) => state.backends.includes(o.id))
    : searchBackendOptions;
  const nameOf = (id: string) =>
    searchBackendOptions.find((o) => o.id === id)?.name ?? id;
  const dirty = Boolean(state) && draft !== state.defaultBackend;

  async function run(operation: () => Promise<any>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await operation();
      if (!r.ok) throw new Error(r.error?.message ?? "操作失败");
      setState(r.value);
      setDraft(r.value.defaultBackend);
      setNotice(done);
    } catch (e: any) {
      setError(e.message ?? "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="yu-search" aria-label="网页搜索">
      <style>{css}</style>
      <h2>网页搜索</h2>
      <p className="muted">
        这里保存的是所有新对话和未单独指定的会话使用的搜索后端。切换后立即生效；正在进行的回复会在本轮结束后换成新的工具参数。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p className="muted">正在读取搜索设置…</p>}
      {state && (
        <>
          <h3>默认后端</h3>
          <div role="radiogroup" aria-label="默认搜索后端">
            {options.map((option) => (
              <label
                className="choice"
                key={option.id}
                data-active={draft === option.id}
              >
                <input
                  type="radio"
                  name="yu-search-default"
                  value={option.id}
                  checked={draft === option.id}
                  disabled={busy}
                  onChange={() => setDraft(option.id)}
                />
                <span className="row-name">
                  <span className="choice-name">{option.name}</span>
                  <small>
                    <span className="choice-id">{option.id}</span> ·{" "}
                    {option.detail}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <div className="toolbar">
            <button
              className="save"
              disabled={!dirty || busy}
              onClick={() =>
                run(() => api.setDefault(draft), "默认搜索后端已保存")
              }
            >
              {busy ? "保存中…" : "保存默认后端"}
            </button>
            {dirty && <small>有未保存的修改</small>}
          </div>
          <p className="notice" role="status">
            {notice}
          </p>
          <h3>会话单独指定</h3>
          <p className="muted">
            <code>/websearch-backend</code>{" "}
            只切换当前会话，不改动这里的默认值；恢复该会话后仍然保留。
          </p>
          {state.overrides.length ? (
            <>
              {state.overrides.map((row: any) => (
                <div className="row" key={row.sessionId}>
                  <div className="row-name">
                    <strong>{row.sessionId.slice(-12)}</strong>
                    <small>{row.sessionId}</small>
                  </div>
                  <span className="muted">{nameOf(row.backend)}</span>
                </div>
              ))}
              <div className="toolbar">
                <button
                  disabled={busy}
                  onClick={() =>
                    run(() => api.clearOverrides(), "已清除全部会话覆盖")
                  }
                >
                  清除全部会话覆盖
                </button>
              </div>
            </>
          ) : (
            <div className="empty">没有会话单独指定后端，全部跟随默认值。</div>
          )}
        </>
      )}
    </section>
  );
}

export async function installSearchSettings(ctx: any) {
  await ctx.remote.$mount(searchRemoteInfo);
  ctx.inject(["remote.yuWebSearch"], (scope: any) => {
    const remote = scope.remote.yuWebSearch;
    const api = {
      settings: () => remote.settings(),
      setDefault: (backend: string) => remote.setDefault(backend),
      clearOverrides: () => remote.clearOverrides(),
    };
    scope.effect(() =>
      scope.slots.inject("settings.section", () =>
        scope.slots.register(
          {
            name: "settings.section",
            id: "yu-web-search",
            order: 16,
            label: () => "网页搜索",
            inject: () => ({ api }),
          },
          WebSearchSettings,
        ),
      ),
    );
  });
}
