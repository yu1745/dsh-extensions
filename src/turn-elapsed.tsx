import React from "react";
import { workedForLabel } from "./turn-elapsed-format.js";

/**
 * 一轮完成后追加的 Codex 风格用时标注。
 *
 * 对齐 Codex CLI 的 `FinalMessageSeparator`：只在回合**正常完成**时出现
 * （`turn/end` 的 reason 为 `completed`；中断、失败、输出上限都不显示），
 * 时长取回合自身的 `turn/end.time - turn/start.time`，因此重放历史时同样出现，
 * 且不需要任何本地计时器。缺少起点或终点事件时不占位。
 */
export function TurnElapsed({ turn }: { turn: any }) {
  const end = turn?.end;
  if (end === undefined || end === null) return null;
  if (end.data?.reason?.kind !== "completed") return null;
  const startedAt = turn?.start?.time;
  if (typeof startedAt !== "number" || typeof end.time !== "number") return null;
  const elapsedMs = end.time - startedAt;
  if (!Number.isFinite(elapsedMs)) return null;
  return (
    <div
      className="yu-worked-for"
      style={{
        color: "var(--dsw-alias-label-tertiary, inherit)",
        fontSize: 12,
        lineHeight: 1.5,
        opacity: 0.75,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {workedForLabel(elapsedMs)}
    </div>
  );
}
