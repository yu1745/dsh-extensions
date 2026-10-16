import React, { useEffect, useId, useMemo, useRef, useState } from "react";
export type ChartRange = "24h" | "7d" | "30d" | "all";
export type ChartPoint = { timestamp: number; value: number };
export type ChartLine = {
  key: string;
  name: string;
  unit: string;
  value?: number;
  rows: ChartPoint[];
};
const durations = { "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 };
const colors = ["#208c7a", "#4c7de0", "#9866cd", "#cb8332", "#cc6183"];
const formatValue = (value: number, unit: string) =>
  unit === "USD"
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value)
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit === "%" ? "%" : ` ${unit}`}`;
export function HistoryChart({
  lines,
  range,
  title,
}: {
  lines: ChartLine[];
  range: ChartRange;
  title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [width, setWidth] = useState(480);
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(200, entry.contentRect.width)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const chart = useMemo(() => {
    const now = Date.now();
    const start = range === "all" ? -Infinity : now - durations[range];
    const plotted = lines
      .map((line, i) => ({
        ...line,
        color: colors[i % colors.length],
        rows: line.rows
          .filter(
            (p) =>
              Number.isFinite(p.value) &&
              Number.isFinite(p.timestamp) &&
              p.timestamp >= start &&
              p.timestamp <= now,
          )
          .sort((a, b) => a.timestamp - b.timestamp),
      }))
      .filter((line) => !hidden.includes(line.key));
    const timestamps = [
      ...new Set(plotted.flatMap((line) => line.rows.map((p) => p.timestamp))),
    ].sort((a, b) => a - b);
    const values = plotted.flatMap((line) => line.rows.map((p) => p.value));
    const unit = plotted[0]?.unit ?? "%";
    const minValue = Math.min(...values),
      maxValue = Math.max(...values);
    const padding = Math.max(
      (maxValue - minValue) * 0.15,
      Math.abs(maxValue) * 0.04,
      0.01,
    );
    const minY = unit === "%" ? 0 : Math.max(0, minValue - padding);
    const maxY = unit === "%" ? 100 : maxValue + padding;
    const minT = range === "all" ? timestamps[0] : start;
    const maxT = range === "all" ? timestamps.at(-1) : now;
    return {
      plotted,
      timestamps,
      unit,
      minY,
      maxY,
      minT: minT ?? now - 86400000,
      maxT: maxT ?? now,
    };
  }, [lines, range, hidden]);
  useEffect(() => setSelected(null), [range]);
  const height = 180,
    left = 46,
    right = width - 12,
    top = 12,
    bottom = 150;
  const timeSpan = chart.maxT - chart.minT;
  const x = (time: number) =>
    timeSpan === 0
      ? (left + right) / 2
      : left + ((time - chart.minT) / timeSpan) * (right - left);
  const y = (value: number) =>
    bottom -
    ((value - chart.minY) / (chart.maxY - chart.minY || 1)) * (bottom - top);
  const active =
    selected === null ? null : Math.min(selected, chart.timestamps.length - 1);
  const activeTime = active === null ? undefined : chart.timestamps[active];
  const selectedRows =
    activeTime === undefined
      ? []
      : chart.plotted.flatMap((line) => {
          const point = line.rows.findLast((p) => p.timestamp <= activeTime);
          return point ? [{ ...line, point }] : [];
        });
  const timeLabel = (time: number) =>
    new Date(time).toLocaleString(
      undefined,
      range === "24h"
        ? { hour: "2-digit", minute: "2-digit" }
        : { month: "numeric", day: "numeric" },
    );
  function pointAt(clientX: number, target: SVGSVGElement) {
    const rect = target.getBoundingClientRect();
    const px = ((clientX - rect.left) * width) / rect.width;
    let closest = 0;
    for (let i = 1; i < chart.timestamps.length; i++)
      if (
        Math.abs(x(chart.timestamps[i]) - px) <
        Math.abs(x(chart.timestamps[closest]) - px)
      )
        closest = i;
    setSelected(closest);
  }
  return (
    <div className="yu-history" ref={ref}>
      <div className="yu-legend" aria-label={`${title} 曲线选择`}>
        {lines.map((line, index) => (
          <button
            key={line.key}
            type="button"
            className="yu-metric"
            aria-pressed={!hidden.includes(line.key)}
            onClick={() => {
              setHidden((current) =>
                current.includes(line.key)
                  ? current.filter((key) => key !== line.key)
                  : [...current, line.key],
              );
              setSelected(null);
            }}
          >
            <span className="yu-metric-label">
              <i style={{ background: colors[index % colors.length] }} />
              {line.name}
              {line.unit === "%" ? "剩余" : ""}
            </span>
            <strong>
              {line.value !== undefined
                ? formatValue(line.value, line.unit)
                : "历史记录"}
            </strong>
          </button>
        ))}
      </div>
      {chart.timestamps.length ? (
        <div className="yu-plot">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height={height}
            role="group"
            tabIndex={0}
            aria-label={`${title} 历史曲线，左右方向键查看数据`}
            aria-describedby={activeTime === undefined ? undefined : tooltipId}
            onPointerMove={(event) =>
              pointAt(event.clientX, event.currentTarget)
            }
            onPointerDown={(event) => {
              event.currentTarget.focus();
              pointAt(event.clientX, event.currentTarget);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== "touch") setSelected(null);
            }}
            onFocus={() => setSelected(chart.timestamps.length - 1)}
            onBlur={() => setSelected(null)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
                  event.key,
                )
              )
                return;
              event.preventDefault();
              if (event.key === "Escape") setSelected(null);
              else if (event.key === "Home") setSelected(0);
              else if (event.key === "End")
                setSelected(chart.timestamps.length - 1);
              else
                setSelected((current) =>
                  Math.max(
                    0,
                    Math.min(
                      chart.timestamps.length - 1,
                      (current ?? chart.timestamps.length - 1) +
                        (event.key === "ArrowRight" ? 1 : -1),
                    ),
                  ),
                );
            }}
          >
            {[0, 0.5, 1].map((ratio) => {
              const value = chart.minY + (chart.maxY - chart.minY) * ratio,
                py = y(value);
              return (
                <g key={ratio}>
                  <line
                    x1={left}
                    x2={right}
                    y1={py}
                    y2={py}
                    stroke="currentColor"
                    opacity=".1"
                    strokeDasharray={ratio ? "3 4" : undefined}
                  />
                  <text
                    x={left - 8}
                    y={py + 3}
                    textAnchor="end"
                    fill="currentColor"
                    opacity=".55"
                    fontSize="10"
                  >
                    {value.toLocaleString(undefined, {
                      maximumFractionDigits: chart.unit === "%" ? 0 : 2,
                    })}
                    {chart.unit === "%" ? "%" : ""}
                  </text>
                </g>
              );
            })}
            {chart.plotted.map((line) => {
              const path = line.rows
                .map(
                  (p, i) => `${i ? "L" : "M"}${x(p.timestamp)},${y(p.value)}`,
                )
                .join(" ");
              return (
                <g key={line.key}>
                  {chart.plotted.length === 1 && line.rows.length > 1 && (
                    <path
                      d={`${path} L${x(line.rows.at(-1)!.timestamp)},${bottom} L${x(line.rows[0].timestamp)},${bottom} Z`}
                      fill={line.color}
                      opacity=".07"
                    />
                  )}
                  <path
                    d={path}
                    stroke={line.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    fill="none"
                  />
                  {(line.rows.length === 1 ? line.rows : []).map((p) => (
                    <circle
                      key={p.timestamp}
                      cx={x(p.timestamp)}
                      cy={y(p.value)}
                      r="3.5"
                      fill={line.color}
                    />
                  ))}
                </g>
              );
            })}
            {activeTime !== undefined && (
              <g>
                <line
                  x1={x(activeTime)}
                  x2={x(activeTime)}
                  y1={top}
                  y2={bottom}
                  stroke="currentColor"
                  opacity=".35"
                  strokeDasharray="3 3"
                />
                {selectedRows.map((line) => (
                  <circle
                    key={line.key}
                    cx={x(line.point.timestamp)}
                    cy={y(line.point.value)}
                    r="4"
                    fill={line.color}
                    stroke="var(--dsw-alias-bg-base, white)"
                    strokeWidth="2"
                  />
                ))}
              </g>
            )}
            <text
              x={left}
              y={height - 7}
              fill="currentColor"
              opacity=".55"
              fontSize="10"
            >
              {timeLabel(chart.minT)}
            </text>
            <text
              x={right}
              y={height - 7}
              textAnchor="end"
              fill="currentColor"
              opacity=".55"
              fontSize="10"
            >
              {timeLabel(chart.maxT)}
            </text>
          </svg>
          {activeTime !== undefined && (
            <div
              id={tooltipId}
              role="tooltip"
              className="yu-chart-tooltip"
              style={{
                left: Math.max(0, Math.min(width - 220, x(activeTime) + 12)),
                top: 8,
              }}
            >
              <time>{new Date(activeTime).toLocaleString()}</time>
              {selectedRows.map((line) => (
                <div key={line.key}>
                  <span>
                    <i style={{ background: line.color }} />
                    {line.name}
                  </span>
                  <strong>{formatValue(line.point.value, line.unit)}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="yu-chart-empty">
          {hidden.length === lines.length
            ? "点击上方指标显示曲线"
            : "此时间范围内暂无记录"}
        </div>
      )}
      <div className="yu-chart-caption">
        <span>{chart.timestamps.length} 个记录点</span>
        <span>悬停查看 · 点击指标切换曲线</span>
      </div>
    </div>
  );
}
