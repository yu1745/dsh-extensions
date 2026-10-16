import React, { useState, useEffect, useSyncExternalStore } from "react";
import { remoteInfo } from "./remote.js";
import { HistoryChart, type ChartRange } from "./quota-chart.js";
import { styles } from "./quota-styles.js";
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
    [notice, setNotice] = useState(""),
    [range, setRange] = useState<ChartRange>("7d");
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
      setNotice("已保存新会话默认后端。语义判断设置将在重启 DSH 后生效。");
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
          <div className="yu-range" role="group" aria-label="历史时间范围">
            <span>历史</span>
            {(
              [
                ["24h", "24 小时"],
                ["7d", "7 天"],
                ["30d", "30 天"],
                ["all", "全部"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="yu-providers">
            {Object.entries(labels).map(([id, label]: any) => {
              const item = data.providers?.[id];
              const lines = series(item?.payload);
              const history = data.history?.[item?.account] ?? [];
              return (
                <article className="yu-row" key={id}>
                  <div className="yu-heading">
                    <strong>{label}</strong>
                    <time
                      title={
                        item?.fetchedAt
                          ? new Date(item.fetchedAt).toLocaleString()
                          : undefined
                      }
                    >
                      {item?.fetchedAt
                        ? new Date(item.fetchedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          }) + " 更新"
                        : "尚未更新"}
                    </time>
                  </div>
                  {item?.error && (
                    <p className="yu-warning">
                      {item.error}
                      {item.payload ? "；显示上次成功数据" : ""}
                    </p>
                  )}
                  {!item && <p className="yu-muted">等待后台首次刷新。</p>}
                  {lines.length > 0 && (
                    <HistoryChart
                      title={label}
                      range={range}
                      lines={lines.map((s: any) => ({
                        ...s,
                        rows: history.flatMap((h: any) => {
                          const point = h.points.find(
                            (p: any) => p.name === s.key,
                          );
                          return point
                            ? [{ timestamp: h.timestamp, value: point.value }]
                            : [];
                        }),
                      }))}
                    />
                  )}
                  {item?.payload && (
                    <details className="yu-details">
                      <summary>来源明细与重置时间</summary>
                      <pre>{JSON.stringify(item.payload, null, 2)}</pre>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
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
              <HistoryChart
                title="Codex 每日费用"
                range={range}
                lines={[
                  {
                    key: "usd",
                    name: "每日费用",
                    unit: "USD",
                    value: data.codexLedger.days.at(-1)?.usd,
                    rows: data.codexLedger.days.map((d: any) => ({
                      timestamp: Date.parse(d.date),
                      value: d.usd,
                    })),
                  },
                ]}
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
          <p className="yu-muted">当前会话使用 /websearch-backend 即时切换。</p>
          <div className="yu-controls">
            <label>
              新会话默认搜索后端
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
            async options(session: any) {
              const result = await native.searchBackend(session.sessionId);
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
                active: result.value.backend === id,
                detail: `${id} · 当前会话立即生效`,
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
