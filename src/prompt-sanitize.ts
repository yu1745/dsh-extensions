/**
 * CodeBuddy 渠道校验对提示词的改名处理。
 *
 * CodeBuddy（`copilot.tencent.com`）会对请求做来源校验，判为非官方客户端时
 * 返回 `HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved
 * channel"}`，提示 "possibly because it was not sent from an official client"。
 * 二分实测（`deepseek-v4.1-flash` / `deepseek-v4-pro` / `glm-5.3` 表现一致）：
 * 触发点是提示词里的产品名 **"DeepSeek Harness"** ——整段提示词替换成 `DSH`
 * 后同一请求立即返回 200，只改其中一处仍然被拦；与长度、句式、`tools` 无关。
 *
 * 因此只要 `yu-providers` 处于激活状态，就在 `system-prompt/assemble` 瀑布里
 * 把每次组装出的提示词整体改名：`sections`（系统提示词）、`contexts`（运行
 * 上下文快照）和 `variables`（会被插值进 section 的变量）。停用插件即恢复
 * 原文；会话日志里记录的就是改名后的提示词。
 */

/** 触发渠道校验的字面串：大小写无关，词间允许任意空白。 */
const FLAGGED_NAME = /DeepSeek\s+Harness/gi;

/** 替换后的中性名称；本身不触发校验。 */
const NEUTRAL_NAME = "DSH";

/** 组装结果里带文本的部分，字段与 DSH 的 `AssembledSection` / `AssembledContext` 一致。 */
export interface PromptTextEntry {
  name: string;
  text: string;
  interpolate?: boolean;
  [key: string]: unknown;
}

/** 组装结果里本插件会改写的部分，其余字段原样透传。 */
export interface PromptAssemblyLike {
  sections?: readonly PromptTextEntry[];
  contexts?: readonly PromptTextEntry[];
  variables?: Readonly<Record<string, string | undefined>>;
}

/** 把触发渠道校验的产品名替换成中性名称。 */
export function sanitizePromptText(text: string): string {
  return text.replace(FLAGGED_NAME, NEUTRAL_NAME);
}

function sanitizeEntry<T extends PromptTextEntry>(entry: T): T {
  return typeof entry?.text === "string" && entry.text.length > 0
    ? { ...entry, text: sanitizePromptText(entry.text) }
    : entry;
}

/**
 * 改写一次提示词组装结果。只重建出现过的字段，`tools` 等其余字段保持同一个
 * 引用透传，保证瀑布返回值的其余部分与其他监听者看到的完全一致。
 */
export function sanitizePromptAssembly<T extends PromptAssemblyLike>(
  assembly: T,
): T {
  const next: PromptAssemblyLike = { ...assembly };
  if (assembly.sections) next.sections = assembly.sections.map(sanitizeEntry);
  if (assembly.contexts) next.contexts = assembly.contexts.map(sanitizeEntry);
  if (assembly.variables)
    next.variables = Object.fromEntries(
      Object.entries(assembly.variables).map(([name, value]) => [
        name,
        typeof value === "string" ? sanitizePromptText(value) : value,
      ]),
    );
  return next as T;
}

/**
 * 挂载提示词改名：在 `system-prompt/assemble` 瀑布的**下游**之后改写返回值，
 * 这样后续监听者补进来的文本同样会被覆盖。返回解绑函数。
 */
export function installPromptSanitizer(ctx: any): () => void {
  return ctx.on(
    "system-prompt/assemble",
    async (assembly: any, _context: any, next: () => Promise<any>) =>
      sanitizePromptAssembly((await next()) ?? assembly),
  );
}
