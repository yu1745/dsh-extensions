import React, { useEffect, useState, useSyncExternalStore } from "react";

/**
 * 设置 → 模型页底部的「语义判断（Jev）」区块。
 *
 * Jev 不是聊天模型，DSH 内置提供方目录会过滤掉只有分类器模型的提供方（servesChat），
 * 所以借用模型页的 footer 槽，直接使用 DSH 原生的 `remote.credentials`
 * （describe / set / unset）读写密钥，与模型页其他提供方共用同一个凭据服务。
 *
 * 引用名必须与 auth.ts 的 `refs` 一致：判断服务读取密钥时解析的就是这些名字。
 */
export const JEV_KEYS = [
  { provider: "typesafe", ref: "TYPESAFE_API_KEY", label: "TypeSafe（Jev）" },
  { provider: "openai", ref: "OPENAI_API_KEY", label: "OpenAI Decisions" },
  { provider: "openrouter", ref: "OPENROUTER_API_KEY", label: "OpenRouter Decisions" },
] as const;

type KeyInfo = { configured: boolean; source?: string; writable: boolean };

const copy = {
  zh: {
    title: "语义判断（Jev）",
    detail:
      "网页读取用它判断页面是否加载完成、是否被遮挡。Jev 是决策服务而不是聊天模型，所以不在上方的模型列表里；密钥与其他提供方一样保存在 DSH 凭据服务，不会回显。",
    configured: "已配置",
    missing: "未配置",
    source: "来源",
    placeholder: "输入新密钥以保存或替换",
    save: "保存",
    clear: "清除",
    saving: "保存中…",
    saved: "已保存，下一次判断即生效",
    cleared: "已清除",
    readonly: "凭据服务当前只读。",
    loading: "正在读取…",
    reveal: "显示",
    hide: "隐藏",
  },
  en: {
    title: "Semantic judgement (Jev)",
    detail:
      "Web reading uses it to decide whether a page finished loading or is blocked. Jev is a decision service, not a chat model, so it is not in the model list above. Keys live in the DSH credential service like other providers and are never echoed.",
    configured: "Configured",
    missing: "Not configured",
    source: "Source",
    placeholder: "Enter a new key to save or replace",
    save: "Save",
    clear: "Clear",
    saving: "Saving…",
    saved: "Saved; used from the next judgement",
    cleared: "Cleared",
    readonly: "The credential service is read-only.",
    loading: "Loading…",
    reveal: "Show",
    hide: "Hide",
  },
};

const styles = `.yu-jev{margin:32px 0 8px;padding-top:24px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.yu-jev h3{font-size:14px;font-weight:500;margin:0 0 6px}
.yu-jev-detail{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:640px;margin:0 0 14px}
.yu-jev-row{display:grid;grid-template-columns:minmax(150px,200px) 1fr auto;gap:12px;align-items:start;padding:10px 0}
.yu-jev-name{font-size:13px;font-weight:500}
.yu-jev-state{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.yu-jev-input{display:flex;gap:6px;min-width:0}
.yu-jev input,.yu-jev button{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px}
.yu-jev input{flex:1;min-width:0}
.yu-jev input:focus-visible,.yu-jev button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.yu-jev button:disabled{opacity:.5}
.yu-jev-actions{display:flex;gap:6px}
.yu-jev-msg{font-size:12px;color:var(--dsw-alias-label-secondary);grid-column:2 / -1;margin-top:-4px}
.yu-jev [role=alert]{color:var(--dsw-alias-state-error-primary);font-size:12px;grid-column:2 / -1}
@media(max-width:700px){.yu-jev-row{grid-template-columns:1fr}.yu-jev-msg,.yu-jev [role=alert]{grid-column:1}}`;

function unwrap(response: any) {
  if (!response?.ok) throw new Error(response?.error?.message ?? "凭据服务不可用");
  return response.value;
}

function KeyRow({ item, info, t, remote, reload }: { item: (typeof JEV_KEYS)[number]; info?: KeyInfo; t: typeof copy.zh; remote: any; reload: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const writable = info?.writable !== false;
  async function run(task: () => Promise<void>, done: string) {
    setBusy(true); setError(""); setMessage(t.saving);
    try { await task(); setValue(""); setShown(false); await reload(); setMessage(done); }
    catch (failure: any) { setMessage(""); setError(String(failure?.message ?? failure)); }
    finally { setBusy(false); }
  }
  const id = `yu-jev-${item.provider}`;
  return (
    <div className="yu-jev-row">
      <div>
        <label className="yu-jev-name" htmlFor={id}>{item.label}</label>
        <div className="yu-jev-state">
          {!info ? t.loading : info.configured ? `${t.configured}${info.source ? ` · ${t.source}：${info.source}` : ""}` : t.missing}
        </div>
      </div>
      <div className="yu-jev-input">
        <input id={id} type={shown && value ? "text" : "password"} autoComplete="new-password" spellCheck={false}
          placeholder={t.placeholder} value={value} disabled={busy || !writable}
          onChange={(event) => setValue(event.target.value)} />
        <button type="button" disabled={!value} aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? t.hide : t.reveal}</button>
      </div>
      <div className="yu-jev-actions">
        <button type="button" disabled={busy || !writable || !value.trim()}
          onClick={() => void run(async () => unwrap(await remote.credentials.set(item.ref, value.trim())), t.saved)}>{t.save}</button>
        <button type="button" disabled={busy || !writable || !info?.configured}
          onClick={() => void run(async () => unwrap(await remote.credentials.unset(item.ref)), t.cleared)}>{t.clear}</button>
      </div>
      {!writable && <div className="yu-jev-msg">{t.readonly}</div>}
      {message && !error && <div className="yu-jev-msg" role="status">{message}</div>}
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

export function JevSettingsSection({ remote, language = "zh" }: { remote: any; language?: string }) {
  const t = language.toLowerCase().startsWith("zh") ? copy.zh : copy.en;
  const [infos, setInfos] = useState<Record<string, KeyInfo> | null>(null);
  const [error, setError] = useState("");
  async function reload() {
    const value = unwrap(await remote.credentials.describe(JEV_KEYS.map((item) => item.ref)));
    setInfos(value);
  }
  useEffect(() => { reload().catch((failure: any) => setError(String(failure?.message ?? failure))); }, [remote]);
  return (
    <section className="yu-jev" aria-label={t.title}>
      <style>{styles}</style>
      <h3>{t.title}</h3>
      <p className="yu-jev-detail">{t.detail}</p>
      {error && <div role="alert">{error}</div>}
      {JEV_KEYS.map((item) => (
        <KeyRow key={item.ref} item={item} info={infos?.[item.ref]} t={t} remote={remote} reload={reload} />
      ))}
    </section>
  );
}

export function installJevSettings(ctx: any) {
  ctx.inject(["remote.credentials", "locale"], (scope: any) => {
    function View() {
      const locale = useSyncExternalStore((notify: () => void) => scope.locale.subscribe(notify), () => scope.locale.getSnapshot());
      return <JevSettingsSection remote={scope.remote} language={typeof locale === "string" ? locale : (locale as any)?.active ?? "zh"} />;
    }
    scope.slots.inject("settings.models.footer", () => scope.slots.register({ name: "settings.models.footer", id: "yu-jev-keys", order: 100 }, View));
  });
}
