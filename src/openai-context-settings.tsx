import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createOpenaiContextSettingsClient, createSettingsSubscription } from './openai-context-setting-client.mjs';

// Locale keys may be bridged to ctx.locale by the owner; the built-in English and
// Chinese text also lets isolated consumers render without a Locale dependency.
export const openaiContextMessages = {
  en: {
    title: 'OpenAI Context', intro: 'Choose the global default manually. No capability probe or automatic fallback is performed.',
    windows: 'Rolling windows', windowsDetail: 'Use the experimental notes/history window workflow.',
    remote: 'Remote compaction', remoteDetail: 'Use provider compaction; details can be lost, but the original session log is retained.',
    remoteSpeed: 'Remote compaction speed', standard: 'Normal', fast: 'Fast',
    standardDetail: 'Use normal request priority.', fastDetail: 'Request priority service when supported.',
    remoteSpeedDetail: 'Only applies to remote compaction, independently of chat speed. Fast may increase cost and requires API and model support.',
    boundary: 'New sessions use the saved default; uncompressed sessions apply changes at the next safe step. Sessions with committed encrypted context remain bound to their original mode. This setting does not migrate or erase their history.',
    save: 'Save', saving: 'Saving…', saved: 'Saved', unsaved: 'Unsaved changes', loading: 'Loading settings…',
    readonly: 'Settings are read-only.', reload: 'Reload', group: 'Global OpenAI context mode',
    externalChange: 'This setting changed elsewhere. Reload before saving; your unsaved choice is preserved.',
    accountTitle: 'OpenAI Codex account', accountIntro: 'Manual device login shared by every openai-codex entry. Credentials are stored only here and never read from the codex CLI or any other file.',
    login: 'Log in with device code', cancelLogin: 'Cancel login', logout: 'Log out',
    loggedInAs: 'Logged in', accountLabel: 'Account', expiresLabel: 'Token expires',
    anonymousState: 'Not logged in. openai-codex routes need a login before use.',
    loginPending: 'Open the link and confirm this code to finish login:', openLink: 'Open login page',
    loginFailed: 'Login failed', loggedOut: 'Logged out', loginStarted: 'Waiting for confirmation…',
  },
  zh: {
    title: 'OpenAI 上下文', intro: '手动选择全局默认方式，不自动探测能力或切换后端。',
    windows: '滚动窗口', windowsDetail: '使用实验性的 notes/history 滚动窗口流程。',
    remote: '远程压缩', remoteDetail: '由提供方压缩上下文，可能丢失细节；原始会话日志保留。',
    remoteSpeed: '远程压缩速度', standard: '普通', fast: 'Fast',
    standardDetail: '使用普通请求优先级。', fastDetail: '在支持时请求优先服务。',
    remoteSpeedDetail: '仅用于远程压缩，与聊天速度独立。Fast 可能增加费用，并且需要接口和模型支持。',
    boundary: '新会话使用保存的默认值；尚未压缩的会话在下一次安全步骤应用更改。已有加密上下文的会话继续使用原方式；此设置不会迁移或清除旧上下文。',
    save: '保存', saving: '保存中…', saved: '已保存', unsaved: '有未保存的修改', loading: '正在读取设置…',
    readonly: '设置为只读。', reload: '重新加载', group: '全局 OpenAI 上下文方式',
    externalChange: '此设置已在别处修改，请重新加载后再保存；当前未保存的选择暂时保留。',
    accountTitle: 'OpenAI Codex 账号', accountIntro: '所有 openai-codex 项共享的手动 device 登录。凭证只保存在这里，不再从 codex CLI 或任何其他文件读取。',
    login: '设备码登录', cancelLogin: '取消登录', logout: '退出登录',
    loggedInAs: '已登录', accountLabel: '账号', expiresLabel: '令牌到期',
    anonymousState: '未登录。openai-codex 相关条目需要先登录才能使用。',
    loginPending: '打开链接并确认以下代码完成登录：', openLink: '打开登录页面',
    loginFailed: '登录失败', loggedOut: '已退出登录', loginStarted: '等待确认…',
  },
} as const;
type MessageKey = keyof typeof openaiContextMessages.en;
type Mode = 'windows' | 'remote';
type RemoteSpeed = 'standard' | 'fast';
type SettingsValue = { mode: Mode; remoteSpeed: RemoteSpeed };
type Snapshot = SettingsValue & { revision: number; writable: boolean };
type Api = { read(): Promise<Snapshot>; save(value: Mode | SettingsValue, revision: number): Promise<Snapshot>; subscribe?(notify: () => void): () => void };
type AuthApi = { status(): Promise<any>; login(): Promise<any>; cancel(): Promise<any>; logout(): Promise<any> };
type Props = { api: Api; locale?: string; t?: (key: MessageKey) => string; auth?: AuthApi };

const css = `
.yu-openai-context{max-width:820px;margin:0 auto;padding:28px 24px 48px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.yu-openai-context *{box-sizing:border-box}.yu-openai-context h2{font-size:21px;font-weight:600;margin:0 0 8px}.yu-openai-context h3{font-size:15px;font-weight:600;margin:24px 0 4px}.yu-openai-context p{margin:8px 0 16px}
.yu-openai-context .muted{color:var(--dsw-alias-label-secondary);font-size:13px}.yu-openai-context .option{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px 12px;margin:8px 0;cursor:pointer}
.yu-openai-context .option[data-active=true]{border-color:var(--dsw-alias-brand-primary)}.yu-openai-context .option[data-disabled=true]{opacity:.55;cursor:default}.yu-openai-context input{margin-top:5px;accent-color:var(--dsw-alias-brand-primary)}.yu-openai-context small{display:block;color:var(--dsw-alias-label-secondary)}
.yu-openai-context button{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:7px;padding:6px 12px;cursor:pointer}
.yu-openai-context button:disabled{opacity:.5;cursor:default}.yu-openai-context button:focus-visible,.yu-openai-context input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.yu-openai-context .actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px}.yu-openai-context .error{color:var(--dsw-alias-state-error-primary)}.yu-openai-context .status{color:var(--dsw-alias-state-success-primary)}
.yu-openai-context .yu-openai-context-account{margin-top:28px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}.yu-openai-context .yu-openai-context-code code{font-size:17px;letter-spacing:2px;font-weight:600}
.yu-openai-context a{color:var(--dsw-alias-brand-primary)}
@media(max-width:600px){.yu-openai-context{padding:20px 14px}}
`;

/** Any wire shape becomes a plain, render-safe view; errors become strings. */
function normalizeAuthState(value: any): any {
  const error = value?.error;
  return {
    state: typeof value?.state === 'string' ? value.state : 'anonymous',
    accountId: typeof value?.accountId === 'string' ? value.accountId : undefined,
    expires: typeof value?.expires === 'number' ? value.expires : undefined,
    userCode: typeof value?.userCode === 'string' ? value.userCode : undefined,
    verificationUri: typeof value?.verificationUri === 'string' ? value.verificationUri : undefined,
    expiresAt: typeof value?.expiresAt === 'number' ? value.expiresAt : undefined,
    error: error === undefined || error === null ? '' : typeof error === 'object' ? String(error.message ?? JSON.stringify(error)) : String(error),
  };
}

/** One shared manual device login for every openai-codex entry. */
function CodexAccountSection({ auth, locale = 'en', t }: { auth: AuthApi; locale?: string; t?: (key: MessageKey) => string }) {
  const messages = locale.toLowerCase().startsWith('zh') ? openaiContextMessages.zh : openaiContextMessages.en;
  const label = (key: MessageKey) => t?.(key) ?? messages[key];
  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [generation, reload] = useState(0);
  const pending = state?.state === 'pending';
  useEffect(() => {
    let active = true;
    auth.status().then(value => { if (active) setState(normalizeAuthState(value)); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [auth, generation]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => reload(value => value + 1), 3000);
    return () => clearInterval(timer);
  }, [pending]);
  async function run(action: () => Promise<any>, done?: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(done ? label('loginStarted') : '');
    try { setState(normalizeAuthState(await action())); if (done) setNotice(label(done)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="yu-openai-context-account" aria-label={label('accountTitle')}>
    <h3>{label('accountTitle')}</h3>
    <p className="muted">{label('accountIntro')}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {state?.error && <p className="error" role="alert">{label('loginFailed')}: {state.error}</p>}
    {notice && <p className="status" role="status">{notice}</p>}
    {state && !pending && (state.state === 'logged-in'
      ? <p className="muted">{label('loggedInAs')} · {label('accountLabel')}: <code>{String(state.accountId ?? '')}</code>
          {typeof state.expires === 'number' && <> · {label('expiresLabel')}: {new Date(state.expires).toLocaleString()}</>}</p>
      : <p className="muted">{label('anonymousState')}</p>)}
    {state && pending && <p className="muted">
      {label('loginPending')} <strong className="yu-openai-context-code"><code>{String(state.userCode ?? '')}</code></strong><br />
      {state.verificationUri && <a href={String(state.verificationUri)} target="_blank" rel="noreferrer">{label('openLink')}</a>}
    </p>}
    <div className="actions">
      {!pending && <button disabled={busy} onClick={() => run(() => auth.login())}>{label('login')}</button>}
      {pending && <button disabled={busy} onClick={() => run(() => auth.cancel())}>{label('cancelLogin')}</button>}
      {state?.state === 'logged-in' && <button disabled={busy} onClick={() => run(() => auth.logout(), 'loggedOut')}>{label('logout')}</button>}
    </div>
  </section>;
}

/** Unregistered settings.section view. The owner supplies a stable API and locale. */
export function OpenaiContextSettings({ api, locale = 'en', t, auth }: Props) {
  const messages = locale.toLowerCase().startsWith('zh') ? openaiContextMessages.zh : openaiContextMessages.en;
  const label = (key: MessageKey) => t?.(key) ?? messages[key];
  const [state, setState] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Mode>('windows');
  const [speedDraft, setSpeedDraft] = useState<RemoteSpeed>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [generation, reload] = useState(0);
  const latest = useRef({ state, draft, speedDraft, busy });
  latest.current = { state, draft, speedDraft, busy };
  const dirty = state !== null && (draft !== state.mode || speedDraft !== state.remoteSpeed);
  useEffect(() => {
    return api.subscribe?.(() => {
      const current = latest.current;
      if (current.busy) return;
      if (current.state && (current.draft !== current.state.mode || current.speedDraft !== current.state.remoteSpeed)) {
        setConflict(true); setError(label('externalChange'));
      } else {
        setConflict(false); setNotice(''); reload(value => value + 1);
      }
    });
  }, [api]);
  useEffect(() => {
    let active = true;
    setError(''); setState(null);
    api.read().then(value => { if (active) { const next: Snapshot = { ...value, remoteSpeed: value.remoteSpeed ?? 'standard' }; setState(next); setDraft(next.mode); setSpeedDraft(next.remoteSpeed); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [api, generation]);
  async function save() {
    if (!state || busy || conflict || !state.writable || !dirty) return;
    latest.current.busy = true;
    setBusy(true); setError(''); setNotice('');
    try { const value = await api.save({ mode: draft, remoteSpeed: speedDraft }, state.revision); const next: Snapshot = { ...value, remoteSpeed: value.remoteSpeed ?? 'standard' }; setState(next); setDraft(next.mode); setSpeedDraft(next.remoteSpeed); setConflict(false); setNotice(label('saved')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { latest.current.busy = false; setBusy(false); }
  }
  return <section className="yu-openai-context" aria-label={label('title')}>
    <style>{css}</style><h2>{label('title')}</h2><p className="muted">{label('intro')}</p><p className="muted">{label('boundary')}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!state && !error && <p className="muted">{label('loading')}</p>}
    {state && <>
      {!state.writable && <p className="muted">{label('readonly')}</p>}
      <div role="radiogroup" aria-label={label('group')}>
        {(['windows', 'remote'] as const).map(mode => <label className="option" key={mode} data-active={draft === mode}>
          <input type="radio" name="yu-openai-context-mode" value={mode} checked={draft === mode} disabled={busy || !state.writable} onChange={() => { latest.current.draft = mode; setDraft(mode); }} />
          <span><strong>{label(mode)}</strong><small>{label(mode === 'windows' ? 'windowsDetail' : 'remoteDetail')}</small></span>
        </label>)}
      </div>
      <h3>{label('remoteSpeed')}</h3>
      <p id="yu-openai-context-speed-detail" className="muted">{label('remoteSpeedDetail')}</p>
      <div role="radiogroup" aria-label={label('remoteSpeed')} aria-describedby="yu-openai-context-speed-detail" aria-disabled={draft !== 'remote' || busy || !state.writable}>
        {(['standard', 'fast'] as const).map(speed => <label className="option" key={speed} data-active={speedDraft === speed} data-disabled={draft !== 'remote' || busy || !state.writable}>
          <input type="radio" name="yu-openai-context-remote-speed" value={speed} checked={speedDraft === speed} disabled={draft !== 'remote' || busy || !state.writable} onChange={() => { latest.current.speedDraft = speed; setSpeedDraft(speed); }} />
          <span><strong>{label(speed)}</strong><small>{label(speed === 'standard' ? 'standardDetail' : 'fastDetail')}</small></span>
        </label>)}
      </div>
      <div className="actions"><button disabled={busy || conflict || !state.writable || !dirty} onClick={save}>{label(busy ? 'saving' : 'save')}</button>
        {dirty && <span className="muted">{label('unsaved')}</span>}
        {notice && <span className="status" role="status">{notice}</span>}
      </div>
      {auth && <CodexAccountSection auth={auth} locale={locale} t={t} />}
    </>}
    {error && <button disabled={busy} onClick={() => { setConflict(false); setNotice(''); reload(value => value + 1); }}>{label('reload')}</button>}
  </section>;
}

/** Register one user-only global setting in the host's Settings navigation. */
export function installOpenaiContextSettings(ctx: any) {
  ctx.inject(['remote.settings', 'locale'], (scope: any) => {
    const locale = scope.locale;
    const settingsNamespace = 'yu-openai-windows';
    const base = createOpenaiContextSettingsClient(scope.remote.settings, settingsNamespace);
    const api = { ...base, subscribe: createSettingsSubscription(scope, settingsNamespace) };
    const namespace = 'yu-openai-context';
    scope.effect(() => {
      const removeEn = locale.register(namespace, 'en', openaiContextMessages.en);
      const removeZh = locale.register(namespace, 'zh', openaiContextMessages.zh);
      return () => { removeZh(); removeEn(); };
    });
    const t = locale.bind(namespace);
    // The shared openai-codex device login lives on the same settings page.
    // Optional: the section is hidden when the auth remote is unavailable.
    let auth: AuthApi | undefined;
    if (typeof scope.inject === 'function')
      scope.inject(["remote.yuCodexAuth"], (authScope: any) => {
        const remote = authScope.remote.yuCodexAuth;
        // Client stubs may hand back the raw {ok, value|error} envelope;
        // unwrap it so the component always receives the plain view.
        const unwrap = async (call: () => PromiseLike<any>) => {
          const result = await call();
          if (result && typeof result === 'object' && 'ok' in result) {
            if (result.ok) return result.value;
            const message = result.error?.message ?? result.error ?? 'codex auth request failed';
            throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
          }
          return result;
        };
        auth = {
          status: () => unwrap(() => remote.status()),
          login: () => unwrap(() => remote.login()),
          cancel: () => unwrap(() => remote.cancel()),
          logout: () => unwrap(() => remote.logout()),
        };
        authScope.on("dispose", () => { auth = undefined; });
      });
    function View() {
      useSyncExternalStore((notify: () => void) => locale.subscribe(notify), () => locale.getSnapshot(), () => locale.getSnapshot());
      return <OpenaiContextSettings api={api} t={t} auth={auth} />;
    }
    scope.effect(() => {
      let unmount: (() => void) | undefined;
      const register = () => {
        unmount?.();
        unmount = scope.slots.inject('settings.section', () => scope.slots.register({
          name: 'settings.section', id: 'yu-openai-context', order: 17, label: () => t('title'),
        }, View));
      };
      register();
      const unlisten = scope.on('locale/change', register);
      return () => { unlisten(); unmount?.(); };
    });
  });
}
