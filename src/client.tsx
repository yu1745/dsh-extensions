import React, { useState, useEffect, useSyncExternalStore } from "react";
import { remoteInfo } from "./remote.js";
const ID = "@yu1745/dsh-extensions";
const labels: any = {
  deepseek: "DeepSeek",
  "zai-coding-cn": "GLM",
  "minimax-cn": "MiniMax",
  "openai-codex": "OpenAI Codex",
  antigravity: "Antigravity",
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(n);
const styles = `.yu-quota{font:inherit;padding:20px;color:var(--dsw-alias-text-primary,inherit);max-width:980px;margin:auto}.yu-quota h2{font-size:22px;margin:0 0 6px}.yu-quota h3{font-size:16px;margin:24px 0 10px}.yu-quota p{line-height:1.6;margin:6px 0}.yu-muted{opacity:.65;font-size:12px}.yu-row{border-top:1px solid var(--dsw-alias-border-l3,#ccc);padding:16px 0}.yu-heading{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.yu-quota button,.yu-quota select,.yu-quota input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l3,#aaa);border-radius:8px;padding:7px 10px}.yu-quota button{cursor:pointer;transition:transform .15s}.yu-quota button:active{transform:scale(.98)}.yu-quota :focus-visible{outline:2px solid #788c5d;outline-offset:3px}.yu-quota button:disabled{opacity:.5;cursor:wait}.yu-controls{display:grid;grid-template-columns:1fr 1fr;gap:12px}.yu-controls label{display:grid;gap:6px;font-size:13px}.yu-quota pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:240px;overflow:auto}.yu-chart{display:block;width:100%;height:116px;margin:10px 0 0;overflow:visible}.yu-warning{color:var(--dsw-alias-text-warning,#9b5a19)}.yu-details{font-size:12px;margin-top:8px}.yu-skeleton{height:100px;border-radius:10px;background:var(--dsw-alias-border-l3,#eee);opacity:.5;animation:yu-pulse 1.6s ease-in-out infinite}.yu-table{border-collapse:collapse;width:100%;font-size:12px}.yu-table td,.yu-table th{padding:8px 4px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l3,#ddd)}@keyframes yu-pulse{50%{opacity:.2}}@media(prefers-reduced-motion:reduce){.yu-skeleton{animation:none}.yu-quota button{transition:none}}@media(max-width:500px){.yu-controls{grid-template-columns:1fr}.yu-quota{padding:14px}}`;
function Chart({ rows, unit }: { rows: any[]; unit: string }) {
  if (!rows.length)
    return (
      <p className="yu-muted">暂无历史记录。后台每分钟检查，数值变化时记录。</p>
    );
  const minT = rows[0].timestamp,
    maxT = rows.at(-1).timestamp;
  const max = unit === "%" ? 100 : Math.max(...rows.map((r) => r.value), 1);
  const min = unit === "%" ? 0 : Math.min(...rows.map((r) => r.value), 0);
  const path = rows
    .map(
      (r, i) =>
        `${i ? "L" : "M"}${(8 + ((r.timestamp - minT) / Math.max(1, maxT - minT)) * 384).toFixed(2)},${(100 - ((r.value - min) / Math.max(1, max - min)) * 84).toFixed(2)}`,
    )
    .join(" ");
  return (
    <>
      <svg
        className="yu-chart"
        viewBox="0 0 400 116"
        role="img"
        aria-label={`${unit} 历史曲线`}
      >
        <path
          d="M8 16H392 M8 100H392"
          stroke="currentColor"
          opacity=".12"
          fill="none"
        />
        <path
          d={path}
          fill="none"
          stroke="#788c5d"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {rows.length === 1 && (
          <circle
            cx="8"
            cy={100 - ((rows[0].value - min) / Math.max(1, max - min)) * 84}
            r="3"
            fill="#788c5d"
          />
        )}
        <text x="8" y="12" fontSize="9" fill="currentColor" opacity=".6">
          {max.toFixed(unit === "%" ? 0 : 2)} {unit}
        </text>
      </svg>
      <p className="yu-muted">
        {new Date(minT).toLocaleString()} — {new Date(maxT).toLocaleString()}
      </p>
    </>
  );
}
function series(payload: any): any[] {
  if (!payload) return [];
  if (payload.currency)
    return [
      {
        name: "余额",
        value: payload.total,
        unit: payload.currency,
        key: "balance",
      },
    ];
  if (payload.buckets)
    return payload.buckets.map((b: any) => ({
      name: b.label,
      value: b.leftPercent,
      unit: "%",
      key: b.label,
    }));
  const windows = payload.interval
    ? { interval: payload.interval, weekly: payload.weekly }
    : payload.primary
      ? { primary: payload.primary, secondary: payload.secondary }
      : {
          quota: { leftPercent: payload.leftPercent },
          week: { leftPercent: payload.weekLeftPercent },
          mcp: { leftPercent: payload.mcpLeftPercent },
        };
  return Object.entries(windows)
    .filter(([, v]: any) => Number.isFinite(v?.leftPercent))
    .map(([key, v]: any) => ({
      name:
        key === "weekly" || key === "week"
          ? "周"
          : key === "mcp"
            ? "MCP"
            : key === "primary" || key === "secondary"
              ? v.windowSeconds
                ? v.windowSeconds >= 604800
                  ? "周"
                  : `${v.windowSeconds / 3600}h`
                : key === "primary"
                  ? "5h"
                  : "周"
              : "5h",
      value: v.leftPercent,
      unit: "%",
      key,
    }));
}
export function Panel({ api }: { api: any }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [prefs, setPrefs] = useState<any>(null),
    [notice, setNotice] = useState("");
  async function reload() {
    setBusy(true);
    try {
      const r = await api.snapshot({});
      if (!r.ok) throw r.error;
      setData(r.value);
      setError("");
    } catch (e: any) {
      setError(e.message ?? "额度服务当前不可用");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void reload();
    void api.preferences({}).then((r: any) => {
      if (r.ok) setPrefs(r.value);
    });
    const id = setInterval(reload, 60000);
    return () => clearInterval(id);
  }, [api]);
  async function save() {
    setNotice("保存中…");
    try {
      const r = await api.savePreferences({ value: prefs });
      if (!r.ok) throw r.error;
      setNotice("已保存。重启 DSH 后生效。");
    } catch (e: any) {
      setNotice(e.message);
    }
  }
  return (
    <section className="yu-quota" aria-label="额度与费用">
      <style>{styles}</style>
      <div className="yu-heading">
        <h2>额度与费用</h2>
        <button onClick={reload} disabled={busy}>
          {busy ? "读取中…" : "读取最新状态"}
        </button>
      </div>
      <p className="yu-muted">
        后台每分钟刷新 · 费用以美元显示 · 历史保留 30 天
      </p>
      {error && (
        <p role="alert" className="yu-warning">
          {error}
        </p>
      )}
      {!data && !error && <div className="yu-skeleton" aria-label="正在读取" />}
      {data && (
        <>
          {Object.entries(labels).map(([id, label]: any) => {
            const item = data.providers?.[id];
            const lines = series(item?.payload);
            const history = data.history?.[item?.account] ?? [];
            return (
              <article className="yu-row" key={id}>
                <div className="yu-heading">
                  <strong>{label}</strong>
                  <span className="yu-muted">
                    {item?.fetchedAt
                      ? new Date(item.fetchedAt).toLocaleString()
                      : "尚未成功更新"}
                  </span>
                </div>
                {item?.error && (
                  <p className="yu-warning">
                    {item.error}
                    {item.payload ? "；显示上次成功数据" : ""}
                  </p>
                )}
                {!item && <p className="yu-muted">等待后台首次刷新。</p>}
                {lines.map((s: any) => (
                  <div key={s.key}>
                    <p>
                      {s.name}{" "}
                      <strong>
                        {s.unit === "USD"
                          ? money(s.value)
                          : `${s.value.toFixed(2)} ${s.unit}`}
                      </strong>
                    </p>
                    <Chart
                      unit={s.unit}
                      rows={history.flatMap((h: any) => {
                        const p = h.points.find((p: any) => p.name === s.key);
                        return p
                          ? [{ timestamp: h.timestamp, value: p.value }]
                          : [];
                      })}
                    />
                  </div>
                ))}
                {item?.payload && (
                  <details className="yu-details">
                    <summary>来源明细与重置时间</summary>
                    <pre>{JSON.stringify(item.payload, null, 2)}</pre>
                  </details>
                )}
              </article>
            );
          })}
          <h3>Codex 跨设备账本</h3>
          <p className="yu-muted">
            官方 credits × {data.codexLedger?.usdPerCredit ?? 0.04}{" "}
            USD；美元值为估算，与本机费用分开显示。
          </p>
          {data.codexLedger?.error && (
            <p className="yu-warning">{data.codexLedger.error}</p>
          )}
          {data.codexLedger?.days?.length ? (
            <>
              <Chart
                unit="USD"
                rows={data.codexLedger.days.map((d: any) => ({
                  timestamp: Date.parse(d.date),
                  value: d.usd,
                }))}
              />
              <table className="yu-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>Credits</th>
                    <th>USD 估算</th>
                  </tr>
                </thead>
                <tbody>
                  {data.codexLedger.days.map((d: any) => (
                    <tr key={d.date}>
                      <td>
                        {d.date}
                        {d.calibrated ? "（已校准）" : ""}
                      </td>
                      <td>{d.credits.toFixed(2)}</td>
                      <td
                        title={
                          d.calibrated
                            ? `原估算 ${money(d.originalUsd)}，沿用 Pi 首日校准`
                            : undefined
                        }
                      >
                        {money(d.usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <details className="yu-details">
                <summary>模型、速度与首日校准明细</summary>
                <pre>{JSON.stringify(data.codexLedger.days, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p className="yu-muted">暂无账本数据。</p>
          )}
          <h3>本机与子代理费用</h3>
          <p className="yu-muted">
            按提供方用量和美元费率估算。总计包含该会话的全部子代理。
          </p>
          {data.sessions?.length ? (
            <table className="yu-table">
              <thead>
                <tr>
                  <th>会话</th>
                  <th>自身 / 含子代理</th>
                  <th>未知价格请求</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s: any) => (
                  <tr key={s.sessionId}>
                    <td title={s.sessionId}>
                      {s.parentSessionId ? "↳ " : ""}
                      {s.sessionId.slice(-12)}
                    </td>
                    <td>
                      {money(s.usd)} / {money(s.totalUsd)}
                    </td>
                    <td>{s.totalUnknown || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="yu-muted">尚无接入后的用量记录。</p>
          )}
        </>
      )}
      {prefs && (
        <>
          <h3>网页工具设置</h3>
          <div className="yu-controls">
            <label>
              搜索后端
              <select
                value={prefs.webSearchBackend}
                onChange={(e) =>
                  setPrefs({ ...prefs, webSearchBackend: e.target.value })
                }
              >
                {["google", "openai", "deepseek", "minimax", "zai"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              语义判断服务
              <select
                value={prefs.classifier.provider}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    classifier: {
                      provider: e.target.value,
                      model:
                        e.target.value === "openrouter"
                          ? "~typesafe/jev-latest"
                          : e.target.value === "openai"
                            ? "gpt-6-luna"
                            : "jev-latest",
                    },
                  })
                }
              >
                {["typesafe", "openai", "openrouter"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Decision 模型 ID
              <input
                value={prefs.classifier.model}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    classifier: { ...prefs.classifier, model: e.target.value },
                  })
                }
              />
            </label>
          </div>
          <p>
            <button onClick={save}>保存工具设置</button>
          </p>
          <p aria-live="polite" className="yu-muted">
            {notice}
          </p>
        </>
      )}
    </section>
  );
}
function QuotaDock({
  api,
  directory,
  open,
}: {
  api: any;
  directory: any;
  open: () => void;
}) {
  const model: any = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot,
  );
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      api
        .snapshot({})
        .then((r: any) => {
          if (alive && r.ok) setData(r.value);
        })
        .catch(() => {});
    void read();
    const timer = setInterval(read, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);
  const provider =
    model.current?.provider === "deepseek-official"
      ? "deepseek"
      : model.current?.provider;
  const item = data?.providers?.[provider];
  const quotas = series(item?.payload);
  const text = quotas.length
    ? `${labels[provider]} ${quotas.map((quota: any) => (quota.unit === "%" ? `${quota.name} 剩余 ${quota.value.toFixed(1)}%` : quota.unit === "USD" ? money(quota.value) : `${quota.value.toFixed(1)} ${quota.unit}`)).join(" · ")}`
    : (labels[provider] ?? "");
  return (
    <button
      type="button"
      onClick={open}
      title="打开余额、余量曲线和美元费用"
      style={{
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
      }}
    >
      额度与费用{text ? ` · ${text}` : ""}
      {item?.error ? " · 更新失败" : ""}
    </button>
  );
}
export const inject = [
  "slots",
  "remote",
  "sidebarRightTabs",
  "sidebarRight",
  "modelDirectories",
  "commandUi",
];
export async function apply(ctx: any) {
  try {
    await ctx.remote.$mount(remoteInfo);
    ctx.inject(["remote.yuQuota", "remote.commands"], (ctx: any) => {
      const native = ctx.remote.yuQuota;
      const api = {
        snapshot: () => native.snapshot(),
        preferences: () => native.preferences(),
        savePreferences: ({ value }: any) => native.savePreferences(value),
      };
      ctx.effect(() =>
        ctx.commandUi.decorate({
          name: "websearch-backend",
          available: () => true,
          ui: {
            kind: "popupSelect",
            searchLabels: () => ({
              placeholder: "选择搜索后端",
              empty: "没有可用后端",
              noResults: "没有匹配的后端",
            }),
            async options() {
              const result = await api.preferences();
              if (!result.ok) throw new Error(result.error.message);
              return [
                ["google", "Google · Antigravity"],
                ["openai", "OpenAI · Codex"],
                ["deepseek", "DeepSeek"],
                ["minimax", "MiniMax"],
                ["zai", "ZAI · 智谱"],
              ].map(([id, label]) => ({
                id,
                label,
                active: result.value.webSearchBackend === id,
                detail: `${id} · 保存后重启 DSH 生效`,
              }));
            },
            async onSelect(option: any, session: any) {
              const result = await ctx.remote.commands.execute(
                session.sessionId,
                `/websearch-backend ${option.id}`,
                [],
              );
              if (!result.ok) throw new Error(result.error.message);
              if (!result.value || result.value.result.kind === "error")
                throw new Error(result.value?.result.text ?? "指令不可用");
            },
          },
        }),
      );
      ctx.effect(() =>
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "yu-quota",
              order: 90,
              inject: (sessionId: string) => ({
                api,
                directory: ctx.modelDirectories.directoryFor(sessionId).store,
                open: () => ctx.sidebarRight.openTabIn(sessionId, "yu-quota"),
              }),
            },
            QuotaDock,
          ),
        ),
      );
      ctx.effect(() =>
        ctx.sidebarRightTabs.register({
          id: ID,
          kind: "yu-quota",
          priority: "extension",
          title: () => "额度与费用",
          guide: [
            {
              id: "quota",
              order: 90,
              title: () => "额度与费用",
              description: () => "查看余额、余量曲线和美元费用",
            },
          ],
        }),
      );
      ctx.effect(() =>
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register(
            { name: "sidebar.right.pane.tab", key: ID },
            () => <Panel api={api} />,
          ),
        ),
      );
      ctx.effect(() =>
        ctx.slots.inject("sidebar.right.pane.tab.title", () =>
          ctx.slots.register(
            { name: "sidebar.right.pane.tab.title", key: ID },
            () => <span>额度与费用</span>,
          ),
        ),
      );
    });
  } catch (error) {
    console.error("[dsh-extensions] client activation failed", error);
    throw error;
  }
}
