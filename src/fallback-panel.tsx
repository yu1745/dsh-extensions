import React, { useEffect, useRef, useState } from "react";
import { fallbackRemoteInfo } from "./fallback-remote.js";
import type { FallbackConfig } from "./fallback-schema.js";

type Group = {
  id: string;
  name: string;
  models: { id: string; name: string }[];
  error?: string;
};
type Drag = {
  kind: "model";
  provider: string;
  model?: string;
};
const initial: FallbackConfig = { enabled: false, models: [] };
const css = `
.yu-fallback{max-width:820px;margin:0 auto;padding:28px 24px 48px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.yu-fallback *{box-sizing:border-box}.yu-fallback h2{font-size:21px;font-weight:600;letter-spacing:-.4px;margin:0 0 8px}.yu-fallback h3{font-size:15px;margin:0;font-weight:600}.yu-fallback p{margin:6px 0 16px}.yu-fallback small,.yu-fallback .muted{color:var(--dsw-alias-label-tertiary);font-size:12px}.yu-fallback button,.yu-fallback input{font:inherit;color:inherit}.yu-fallback button{border:1px solid var(--dsw-alias-border-l1,#ddd);background:var(--dsw-alias-bg-base,transparent);border-radius:7px;padding:5px 10px;cursor:pointer}.yu-fallback button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8881)}.yu-fallback button:active:not(:disabled){transform:scale(.98)}.yu-fallback button:disabled{opacity:.4;cursor:default}.yu-fallback :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#5684d4);outline-offset:2px}.yu-fallback .toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#ddd);margin-bottom:24px}.yu-fallback .switch{display:inline-flex;gap:8px;align-items:center;cursor:pointer}.yu-fallback input[type=checkbox]{accent-color:var(--dsw-alias-label-primary);width:16px;height:16px;flex:none}.yu-fallback .save{background:var(--dsw-alias-label-primary,#333);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}.yu-fallback .section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:26px 0 8px}.yu-fallback .drop-start{padding:9px 12px;border:1px dashed var(--dsw-alias-border-l2,#bbb);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;margin:10px 0}.yu-fallback .row{display:flex;align-items:center;gap:10px;min-height:48px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,#ddd)}.yu-fallback .row-name{flex:1;min-width:0;overflow-wrap:anywhere}.yu-fallback .row-name strong{font-size:13px;font-weight:500}.yu-fallback .row-name small{display:block}.yu-fallback .actions{display:flex;gap:4px;flex:none}.yu-fallback .icon-button{min-width:28px;padding:3px 6px;border-color:transparent}.yu-fallback .grip{display:flex;align-items:center;justify-content:center;width:22px;flex:none;cursor:grab;touch-action:none;color:var(--dsw-alias-label-tertiary)}.yu-fallback .grip:active{cursor:grabbing}.yu-fallback [data-dragging=true]{opacity:.45}.yu-fallback [data-over=true]{box-shadow:inset 0 2px var(--dsw-alias-label-primary,#444)}.yu-fallback .catalog{border-top:1px solid var(--dsw-alias-border-l1,#ddd);margin-top:10px}.yu-fallback details{border-bottom:1px solid var(--dsw-alias-border-l1,#ddd)}.yu-fallback summary{display:flex;align-items:center;gap:9px;padding:13px 2px;cursor:pointer;list-style:none}.yu-fallback summary::before{content:'›';font-size:19px;width:14px;flex:none}.yu-fallback details[open]>summary::before{transform:rotate(90deg)}.yu-fallback summary strong{font-weight:500;flex:1}.yu-fallback .catalog-model{cursor:pointer}.yu-fallback .catalog-model:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.yu-fallback .search{width:100%;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;background:transparent}.yu-fallback .empty{padding:24px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l1,#ddd);border-radius:10px;color:var(--dsw-alias-label-tertiary)}.yu-fallback .error{color:var(--dsw-alias-state-error-primary,#b43c30);font-size:13px;margin:10px 0}.yu-fallback .notice{font-size:12px;min-height:20px;margin:8px 0}.yu-fallback .badge{font-size:11px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,#8881);padding:2px 6px}.yu-fallback .blocked{color:var(--dsw-alias-state-error-primary,#b43c30)}
@media(max-width:600px){.yu-fallback{padding:20px 14px}.yu-fallback .row{gap:5px;padding:8px}.yu-fallback .actions{gap:0}}
`;
function Grip({ label, ...props }: any) {
  return (
    <span
      className="grip"
      draggable
      aria-label={label}
      title={label}
      {...props}
    >
      <svg
        width="12"
        height="16"
        viewBox="0 0 12 16"
        fill="currentColor"
        aria-hidden="true"
      >
        {[4, 8, 12].flatMap((y) =>
          [4, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" />),
        )}
      </svg>
    </span>
  );
}
export function moveItem<T>(items: T[], from: number, to: number) {
  if (
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length ||
    from === to
  )
    return items;
  const copy = [...items],
    [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}
export function FallbackSettings({ api }: { api: any }) {
  const [draft, setDraft] = useState<FallbackConfig>(initial);
  const [saved, setSaved] = useState<FallbackConfig>(initial);
  const [groups, setGroups] = useState<Group[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null),
    [over, setOver] = useState("");
  const root = useRef<HTMLElement>(null),
    pointer = useRef<number | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    let alive = true;
    Promise.all([api.status(), api.catalog()])
      .then(([s, c]) => {
        if (!s.ok || !c.ok)
          throw new Error(s.error?.message ?? c.error?.message ?? "读取失败");
        if (alive) {
          setDraft(s.value.config);
          setSaved(s.value.config);
          setStatus(s.value);
          setGroups(c.value.groups);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const timer = setInterval(() => {
      api
        .status()
        .then((s: any) => {
          if (alive && s.ok) setStatus(s.value);
        })
        .catch(() => {});
    }, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);
  // Keep scrolling while a selected model is dragged within the
  // priority list. Candidate models are selected by checkbox, never dragged.
  useEffect(() => {
    if (!drag) return;
    let frame = 0;
    const update = (event: DragEvent) => {
      pointer.current = event.clientY;
    };
    const scroll = () => {
      const y = pointer.current;
      if (y !== null && root.current) {
        let element: HTMLElement | null = root.current;
        while (
          element &&
          !(
            element.scrollHeight > element.clientHeight &&
            /auto|scroll/.test(getComputedStyle(element).overflowY)
          )
        )
          element = element.parentElement;
        const target = element ?? document.scrollingElement;
        if (target) {
          const bounds = element?.getBoundingClientRect() ?? {
            top: 0,
            bottom: innerHeight,
          };
          const top = Math.max(0, bounds.top),
            bottom = Math.min(innerHeight, bounds.bottom);
          const distance =
            y < top + 80
              ? -Math.min(18, (top + 80 - y) / 4)
              : y > bottom - 80
                ? Math.min(18, (y - bottom + 80) / 4)
                : 0;
          if (distance) target.scrollTop += distance;
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    document.addEventListener("dragover", update);
    frame = requestAnimationFrame(scroll);
    return () => {
      document.removeEventListener("dragover", update);
      cancelAnimationFrame(frame);
      pointer.current = null;
    };
  }, [drag]);
  const nameOf = (provider: string, model: string) =>
    groups.find((g) => g.id === provider)?.models.find((m) => m.id === model)
      ?.name ?? model;
  const providerName = (provider: string) =>
    groups.find((g) => g.id === provider)?.name ?? provider;
  function add(provider: string, model: string, index?: number) {
    setDraft((current) => {
      const copy = current.models.filter(
        (r) => r.provider !== provider || r.model !== model,
      );
      copy.splice(index ?? copy.length, 0, { provider, model });
      return { ...current, models: copy };
    });
    setNotice("");
  }
  function remove(provider: string, model: string) {
    setDraft((current) => ({
      ...current,
      models: current.models.filter(
        (r) => r.provider !== provider || r.model !== model,
      ),
    }));
    setNotice("");
  }
  function reorder(from: number, to: number) {
    setDraft((current) => ({
      ...current,
      models: moveItem(current.models, from, to),
    }));
  }
  function start(event: React.DragEvent, value: Drag) {
    event.stopPropagation();
    event.dataTransfer.setData(
      "application/x-dsh-fallback",
      JSON.stringify(value),
    );
    event.dataTransfer.effectAllowed = "move";
    setDrag(value);
  }
  function finish() {
    setDrag(null);
    setOver("");
  }
  function accept(event: React.DragEvent, id: string) {
    if (drag) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setOver(id);
    }
  }
  function drop(event: React.DragEvent, index?: number) {
    event.preventDefault();
    event.stopPropagation();
    if (drag?.model) add(drag.provider, drag.model, index);
    finish();
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      const s = await api.save(draft);
      if (!s.ok) throw new Error(s.error?.message ?? "保存失败");
      setSaved(s.value.config);
      setDraft(s.value.config);
      setStatus(s.value);
      setNotice("已保存，下一次模型请求生效。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  async function retry(provider: string, model: string) {
    try {
      const s = await api.retry({ provider, model });
      if (!s.ok) throw new Error(s.error?.message ?? "重试失败");
      setStatus(s.value);
      setNotice("已清除该模型的错误冷却；仍会跳过额度接口明确显示耗尽的窗口。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "重试失败");
    }
  }
  const needle = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      models: g.models.filter(
        (m) =>
          `${g.id} ${g.name}`.toLowerCase().includes(needle) ||
          `${m.id} ${m.name}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((g) => g.models.length || g.error);
  return (
    <section className="yu-fallback" ref={root} onDragEnd={finish}>
      <style>{css}</style>
      <h2>模型自动回退</h2>
      <p className="muted">
        按优先级使用模型。5
        小时、周额度或余额耗尽时顺位切换；额度恢复后，在下一次请求优先回到队列前端。
      </p>
      {loading ? (
        <div className="empty" role="status">
          正在读取模型与回退配置…
        </div>
      ) : (
        <>
          <div className="toolbar">
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              启用自动回退
            </label>
            <button className="save" disabled={!dirty || saving} onClick={save}>
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>
          <div role="status" className="notice">
            {dirty ? "有未保存的修改" : notice}
          </div>
          <div className="section-head">
            <h3>优先级队列</h3>
            <span className="muted">{draft.models.length} 个模型</span>
          </div>
          <p className="muted">
            以下仅决定备用顺序，可跨提供方交错排列。当前手动选中的模型视为隐含的第一位，重复出现时只尝试一次。
          </p>
          {drag && (
            <div
              className="drop-start"
              data-over={over === "start"}
              onDragOver={(e) => accept(e, "start")}
              onDrop={(e) => drop(e, 0)}
            >
              移到队首
            </div>
          )}
          {!draft.models.length && (
            <div className="empty">
              尚未选择模型。在下方展开提供方，勾选模型即可加入队列。
            </div>
          )}
          <div
            aria-label="回退优先级"
            onDragOver={(e) => accept(e, "end")}
            onDrop={(e) => drop(e)}
          >
            {draft.models.map((route, index) => {
              const { provider, model } = route;
              const record = status?.models?.find(
                (r: any) => r.provider === provider && r.model === model,
              );
              const blocked = record?.blocked;
              const catalog = groups.find((g) => g.id === provider);
              const missing =
                !catalog ||
                (!catalog.error && !catalog.models.some((m) => m.id === model));
              const active = status?.cursors?.some(
                (c: any) =>
                  c.route.provider === provider && c.route.model === model,
              );
              const key = JSON.stringify([provider, model]);
              return (
                <div
                  className="row"
                  key={key}
                  data-over={over === key}
                  data-dragging={
                    drag?.kind === "model" &&
                    drag.provider === provider &&
                    drag.model === model
                  }
                  onDragOver={(e) => accept(e, key)}
                  onDrop={(e) => drop(e, index)}
                >
                  <Grip
                    label={`拖动模型 ${provider}/${model}`}
                    onDragStart={(e: React.DragEvent) =>
                      start(e, { kind: "model", provider, model })
                    }
                  />
                  <span className="muted">{index + 1}</span>
                  <div className="row-name">
                    <strong>{nameOf(provider, model)}</strong>
                    <small>
                      {providerName(provider)} · {provider}/{model}
                    </small>
                    {blocked && (
                      <small className="blocked">
                        额度耗尽
                        {blocked.until
                          ? ` · ${new Date(blocked.until).toLocaleString()} 后重试`
                          : " · 等待额度恢复"}
                      </small>
                    )}
                    {missing && (
                      <small className="blocked">
                        模型暂不在可用目录中，将跳过
                      </small>
                    )}
                  </div>
                  {active && <span className="badge">正在使用</span>}
                  <div className="actions">
                    {blocked && (
                      <button
                        className="icon-button"
                        aria-label={`重试模型 ${model}`}
                        onClick={() => retry(provider, model)}
                      >
                        重试
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label={`上移模型 ${model}`}
                      disabled={index === 0}
                      onClick={() => reorder(index, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`下移模型 ${model}`}
                      disabled={index === draft.models.length - 1}
                      onClick={() => reorder(index, index + 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`移除模型 ${provider}/${model}`}
                      onClick={() => remove(provider, model)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="section-head">
            <h3>选择模型</h3>
            <button
              disabled={loading}
              onClick={async () => {
                try {
                  const c = await api.catalog();
                  if (!c.ok) throw new Error(c.error?.message ?? "读取失败");
                  setGroups(c.value.groups);
                  setError("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "读取失败");
                }
              }}
            >
              刷新目录
            </button>
          </div>
          <p className="muted">
            候选模型按提供方分组。勾选即加入上方队列；仅已选模型支持拖动排序。
          </p>
          <input
            className="search"
            type="search"
            aria-label="搜索回退模型"
            placeholder="搜索提供方或模型…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="catalog">
            {filtered.map((g) => (
              <details key={g.id} open={needle ? true : undefined}>
                <summary>
                  <strong>{g.name}</strong>
                  <small>
                    {g.id} · {g.models.length} 个模型
                  </small>
                </summary>
                {g.error && <p className="error">{g.error}</p>}
                {g.models.map((m) => {
                  const selected = draft.models.some(
                    (r) => r.provider === g.id && r.model === m.id,
                  );
                  return (
                    <label className="row catalog-model" key={m.id}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${g.id}/${m.id}`}
                        checked={selected}
                        onChange={(e) =>
                          e.target.checked
                            ? add(g.id, m.id)
                            : remove(g.id, m.id)
                        }
                      />
                      <div className="row-name">
                        <strong>{m.name}</strong>
                        <small>{m.id}</small>
                      </div>
                      {selected && <span className="badge">已选择</span>}
                    </label>
                  );
                })}
              </details>
            ))}
          </div>
          {!filtered.length && (
            <div className="empty">
              {groups.length
                ? "没有匹配的提供方或模型"
                : "暂无可用模型，请先配置提供方"}
            </div>
          )}
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
export async function installFallbackSettings(ctx: any) {
  await ctx.remote.$mount(fallbackRemoteInfo);
  ctx.inject(["remote.yuModelFallback"], (scope: any) => {
    const remote = scope.remote.yuModelFallback;
    const api = {
      status: () => remote.status(),
      catalog: () => remote.catalog(),
      save: (value: any) => remote.save(value),
      retry: (route: any) => remote.retry(route),
    };
    scope.effect(() =>
      scope.slots.inject("settings.section", () =>
        scope.slots.register(
          {
            name: "settings.section",
            id: "yu-model-fallback",
            order: 15,
            label: () => "模型自动回退",
            inject: () => ({ api }),
          },
          FallbackSettings,
        ),
      ),
    );
  });
}
