/**
 * Codex CLI 的回合完成标注文案。
 *
 * 逐字对齐 `codex-rs/tui/src/history_cell/separators.rs` 中 `FinalMessageSeparator::label`：
 * 秒数先向下取整；≥1 小时显示 `{h}h {m}m {s}s`，≥1 分钟显示 `{m}m {s}s`，
 * 不足 1 秒显示 `<1s`，其余显示 `{s}s`，并统一加上 `Worked for ` 前缀。
 */

/** 把毫秒耗时折算成 Codex 的分段时长文本，非有限值或负值按 0 处理。 */
export function formatTurnElapsed(elapsedMs: number): string {
  const seconds =
    Number.isFinite(elapsedMs) && elapsedMs > 0
      ? Math.floor(elapsedMs / 1000)
      : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  if (rest === 0) return "<1s";
  return `${rest}s`;
}

/** 完整的 Codex 风格标签，例如 `Worked for 1m 20s`。 */
export function workedForLabel(elapsedMs: number): string {
  return `Worked for ${formatTurnElapsed(elapsedMs)}`;
}
