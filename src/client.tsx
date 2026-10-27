import { installFallbackSettings } from "./fallback-panel.js";
import { installNoWorkspace } from "./no-workspace-client.js";
import { installModelMenu } from "./model-menu.js";
import { ProviderPanel } from "./provider-panel.js";
import { providerRemoteInfo } from "./provider-remote.js";
import React, { useState, useEffect, useSyncExternalStore } from "react";
import { remoteInfo } from "./remote.js";
import { HistoryChart, type ChartRange } from "./quota-chart.js";
import { styles } from "./quota-styles.js";
import { TurnElapsed } from "./turn-elapsed.js";
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
const costMoney = (n: number) =>
  n >= 0.01
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(n)
    : money(n);
const cny = (n: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(n);
const costCny = (n: number) =>
  n >= 0.01
    ? new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(n)
    : cny(n);
function currencyText(currency: string, n: number, compact = false) {
  if (currency === "CNY") return compact ? costCny(n) : cny(n);
  return compact ? costMoney(n) : money(n);
}
function amountsText(amounts: any, compact = false) {
  return Object.entries(amounts ?? {})
    .filter(([, value]) => typeof value === "number" && value !== 0)
    .map(([currency, value]) =>
      currencyText(currency, value as number, compact),
    )
    .join(" + ");
}
/** Current snapshots carry per-currency buckets; older rows only carry USD. */
function sessionAmounts(session: any, total = false) {
  const amounts = session?.[total ? "totalAmounts" : "amounts"];
  if (amounts) return amounts;
  const usd = session?.[total ? "totalUsd" : "usd"];
  return typeof usd === "number" && usd !== 0 ? { USD: usd } : {};
}
function sessionParts(session: any, total = false) {
  return session?.[total ? "totalParts" : "parts"] ?? {};
}
const costTipStyles = `
.yu-cost-dock { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.yu-cost-tip {
  display: none;
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 1000;
  box-sizing: border-box;
  min-width: 200px;
  padding: 9px 11px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  border-radius: 10px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff));
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.14));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  white-space: nowrap;
  pointer-events: none;
}
.yu-cost-dock:hover .yu-cost-tip,
.yu-cost-dock:focus-within .yu-cost-tip { display: block; }
.yu-cost-tip-title { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-tertiary, inherit); }
.yu-cost-tip-block { display: block; }
.yu-cost-tip-block + .yu-cost-tip-block {
  margin-top: 6px;
  padding-top: 6px;
  border-top: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
}
.yu-cost-tip-currency { display: block; color: var(--dsw-alias-label-tertiary, inherit); }
.yu-cost-tip-row { display: flex; justify-content: space-between; gap: 18px; }
.yu-cost-tip-row > span:first-child { color: var(--dsw-alias-label-secondary, inherit); }
.yu-cost-tip-total {
  margin-top: 3px;
  padding-top: 3px;
  border-top: .5px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.15));
  font-weight: 600;
}
.yu-cost-tip-note { display: block; margin-top: 5px; color: var(--dsw-alias-label-tertiary, inherit); }
`;
function CostTipRow({
  label,
  value,
  total = false,
}: {
  label: string;
  value: string;
  total?: boolean;
}) {
  return (
    <span
      className={
        total ? "yu-cost-tip-row yu-cost-tip-total" : "yu-cost-tip-row"
      }
    >
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}
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
    [range, setRange] = useState<ChartRange>("24h");
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
        后台每分钟刷新 · DeepSeek 官方人民币、其余提供方美元 · 历史保留 30 天
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
                  {id === "openai-codex" && item?.payload && (
                    <div className="yu-legend">
                      <div className="yu-metric" aria-label="剩余 credits">
                        <span className="yu-metric-label">剩余 credits</span>
                        <strong>
                          {item.payload.credits?.unlimited
                            ? "不限量"
                            : typeof item.payload.credits?.balance === "number"
                              ? item.payload.credits.balance.toLocaleString(
                                  undefined,
                                  { maximumFractionDigits: 2 },
                                )
                              : "未提供"}
                        </strong>
                      </div>
                    </div>
                  )}
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
            按提供方用量和官方费率估算：DeepSeek
            官方使用人民币价，其余提供方使用美元价；不做汇率换算。总计包含该会话的全部子代理。
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
                      {amountsText(sessionAmounts(s)) || "—"} /{" "}
                      {amountsText(sessionAmounts(s, true)) || "—"}
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
          {api.providers && <ProviderPanel api={api.providers} />}
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
  const quotaText = (quota: any) =>
    quota.unit === "%"
      ? `${quota.name} 剩余 ${quota.value.toFixed(1)}%`
      : quota.unit === "USD"
        ? money(quota.value)
        : quota.unit === "CNY"
          ? cny(quota.value)
          : `${quota.value.toFixed(1)} ${quota.unit}`;
  const text = quotas.length
    ? `${labels[provider]} ${quotas.map(quotaText).join(" · ")}`
    : (labels[provider] ?? "");
  return (
    <button
      type="button"
      onClick={open}
      title="打开余额、余量曲线和费用明细"
      style={dockButtonStyle}
    >
      额度与费用{text ? ` · ${text}` : ""}
      {item?.error ? " · 更新失败" : ""}
    </button>
  );
}
function SessionCostDock({
  api,
  sessionId,
  open,
}: {
  api: any;
  sessionId: string;
  open: () => void;
}) {
  const [session, setSession] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () =>
      api
        .snapshot({})
        .then((r: any) => {
          if (!alive || !r.ok) return;
          setSession(
            r.value?.sessions?.find(
              (row: any) => row.sessionId === sessionId,
            ) ?? null,
          );
          setLoaded(true);
        })
        .catch(() => {});
    void read();
    const timer = setInterval(read, 20000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, sessionId]);
  const own = sessionAmounts(session);
  const total = sessionAmounts(session, true);
  const totalParts = sessionParts(session, true);
  const subagentAmounts: Record<string, number> = {};
  for (const currency of new Set([
    ...Object.keys(own),
    ...Object.keys(total),
  ])) {
    const difference = (total[currency] ?? 0) - (own[currency] ?? 0);
    if (difference > 1e-12) subagentAmounts[currency] = difference;
  }
  const subagents = Object.keys(subagentAmounts).length > 0;
  const requests = session?.requests ?? 0;
  const unknown = session?.totalUnknown ?? 0;
  const totalText = amountsText(total, true);
  const ownText = amountsText(own) || "—";
  const subagentText = amountsText(subagentAmounts) || "—";
  const label = !loaded
    ? "本会话计费…"
    : requests === 0
      ? "本会话计费 —"
      : totalText
        ? `本会话计费 ${totalText}${subagents ? " · 含子代理" : ""}${unknown > 0 ? ` · ${unknown} 未知` : ""}`
        : `本会话计费 —${unknown > 0 ? ` · ${unknown} 未知` : ""}`;
  const title = [
    `本会话自身 ${ownText}`,
    subagents ? `子代理 ${subagentText}` : "",
    `自身 ${requests} 次请求`,
    unknown > 0 ? `${unknown} 次请求价格未知` : "",
    "点击打开额度与费用",
  ]
    .filter(Boolean)
    .join(" · ");
  const currencyBlocks = [
    ...new Set([...Object.keys(total), ...Object.keys(totalParts)]),
  ]
    .map((currency) => ({
      currency,
      amount: total[currency] ?? 0,
      parts: totalParts[currency],
    }))
    .filter(
      ({ amount, parts }) =>
        amount !== 0 ||
        Boolean(
          parts &&
            [parts.cacheRead, parts.input, parts.output, parts.cacheWrite].some(
              (value) => value !== 0,
            ),
        ),
    );
  return (
    <span className="yu-cost-dock">
      <style>{costTipStyles}</style>
      <button
        type="button"
        onClick={open}
        aria-label={title}
        style={dockButtonStyle}
      >
        {label}
      </button>
      <span className="yu-cost-tip" role="tooltip">
        <span className="yu-cost-tip-title">
          本会话计费{subagents ? "（含子代理）" : ""}
        </span>
        {currencyBlocks.length ? (
          currencyBlocks.map(({ currency, amount, parts }) => (
            <span className="yu-cost-tip-block" key={currency}>
              {currencyBlocks.length > 1 ? (
                <span className="yu-cost-tip-currency">{currency}</span>
              ) : null}
              {parts ? (
                <>
                  <CostTipRow
                    label="缓存读"
                    value={currencyText(currency, parts.cacheRead, true)}
                  />
                  <CostTipRow
                    label="输入"
                    value={currencyText(currency, parts.input, true)}
                  />
                  <CostTipRow
                    label="输出"
                    value={currencyText(currency, parts.output, true)}
                  />
                  {parts.cacheWrite > 0 ? (
                    <CostTipRow
                      label="缓存写"
                      value={currencyText(currency, parts.cacheWrite, true)}
                    />
                  ) : null}
                </>
              ) : null}
              <CostTipRow
                label={parts ? "合计" : "费用"}
                value={currencyText(currency, amount, true)}
                total
              />
            </span>
          ))
        ) : (
          <span className="yu-cost-tip-note">暂无计费记录</span>
        )}
        {subagents ? (
          <span className="yu-cost-tip-note">其中子代理 {subagentText}</span>
        ) : null}
        <span className="yu-cost-tip-note">
          {requests} 次请求
          {unknown > 0 ? ` · ${unknown} 个未知价格` : ""}
        </span>
        <span className="yu-cost-tip-note">点击打开额度与费用</span>
      </span>
    </span>
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
  installModelMenu(ctx);
  try {
    await installNoWorkspace(ctx);
    await installFallbackSettings(ctx);
    await ctx.remote.$mount(remoteInfo);
    await ctx.remote.$mount(providerRemoteInfo);
    ctx.inject(["remote.yuQuota", "remote.commands"], (ctx: any) => {
      const native = ctx.remote.yuQuota;
      const api = {
        providers: undefined as any,
        snapshot: () => native.snapshot(),
        speed: (sessionId: string) => native.speed(sessionId),
        setFast: (sessionId: string, enabled: boolean) =>
          native.setFast(sessionId, enabled),
        preferences: () => native.preferences(),
        savePreferences: ({ value }: any) => native.savePreferences(value),
      };
      ctx.inject(["remote.yuProviders"], (providerCtx: any) => {
        const providers = providerCtx.remote.yuProviders;
        api.providers = {
          status: () => providers.status(),
          loginStart: (id: string) => providers.loginStart(id),
          loginAnswer: (answer: any) => providers.loginAnswer(answer),
          loginCancel: (id: string) => providers.loginCancel(id),
        };
        providerCtx.on("dispose", () => {
          api.providers = undefined;
        });
      });
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
              id: "yu-codex-fast",
              order: 1000,
              inject: (sessionId: string) => ({
                api,
                sessionId,
                directory: ctx.modelDirectories.directoryFor(sessionId).store,
              }),
            },
            CodexFastToggle,
          ),
        ),
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
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "yu-session-cost",
              order: 95,
              inject: (sessionId: string) => ({
                api,
                sessionId,
                open: () => ctx.sidebarRight.openTabIn(sessionId, "yu-quota"),
              }),
            },
            SessionCostDock,
          ),
        ),
      );
      ctx.effect(() =>
        ctx.slots.inject("conversation.chat.turnTail", () =>
          ctx.slots.register(
            {
              name: "conversation.chat.turnTail",
              id: "yu-worked-for",
              order: 30,
            },
            TurnElapsed,
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
              description: () => "查看余额、余量曲线和本机费用",
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
