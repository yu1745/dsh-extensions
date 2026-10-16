import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

const css = `
.yu-model-trigger{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:6px;padding:4px 8px;max-width:min(400px,55vw);display:flex;gap:7px;align-items:center;cursor:pointer}
.yu-model-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.yu-model-trigger small{color:var(--dsw-alias-label-caption);flex:none}
.yu-model-menu{position:fixed;z-index:1100;box-sizing:border-box;width:360px;max-width:calc(100vw - 24px);max-height:min(460px,calc(100dvh - 32px));display:flex;flex-direction:column;padding:6px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:var(--dsw-elevation-prominent,0 8px 32px #0002);font-size:13px}
.yu-model-menu button{font:inherit;color:inherit;cursor:pointer;border:0;background:transparent;border-radius:6px}.yu-model-menu button:disabled,.yu-model-trigger:disabled{opacity:.5;cursor:default}
.yu-model-menu button:hover:not(:disabled),.yu-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}
.yu-model-menu button:focus-visible,.yu-model-menu input:focus-visible,.yu-model-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#5684d4);outline-offset:-2px}
.yu-model-head{display:flex;align-items:center;gap:6px;min-height:34px;padding:0 2px}.yu-model-head strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.yu-model-head button{padding:6px 8px}.yu-model-head small{color:var(--dsw-alias-label-caption)}
.yu-model-search{display:flex;gap:4px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1,#ddd);padding:5px 2px 8px;margin-bottom:4px}.yu-model-search input{width:100%;min-width:0;box-sizing:border-box;font:inherit;color:inherit;background:transparent;border:0;border-radius:4px;padding:6px}.yu-model-search button{padding:6px}
.yu-model-list{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}.yu-model-row{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:7px 9px;text-align:left}.yu-model-row>span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}.yu-model-row small{display:block;font-size:11px;color:var(--dsw-alias-label-caption);margin-top:2px}.yu-model-row em{font-size:12px;font-style:normal;color:var(--dsw-alias-label-caption);flex:none}.yu-model-row[aria-checked=true],.yu-model-row[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.yu-model-status{font-size:12px;padding:9px;color:var(--dsw-alias-label-secondary)}.yu-model-error{font-size:12px;padding:8px;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary,#b43c30)}.yu-model-error button{margin-left:8px;text-decoration:underline}.yu-model-foot{border-top:1px solid var(--dsw-alias-border-l1,#ddd);padding-top:4px;margin-top:4px}
.yu-model-menu--root{width:300px}.yu-model-submenu{z-index:1101;width:360px}.yu-model-submenu--effort{width:240px}
`;

type Model = {
  id: string;
  name: string;
  reasoning?: {
    defaultEffort?: string;
    efforts: { id: string; name: string }[];
  };
};
type Group = { id: string; name: string; models: Model[] };
export function ModelMenu({ locked, available, directory, load, select }: any) {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
  ) as any;
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<
    { provider: string } | "effort" | null
  >(null);
  const [query, setQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<React.CSSProperties>({
    visibility: "hidden",
  });
  const [subPosition, setSubPosition] = useState<React.CSSProperties>({
    visibility: "hidden",
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const child = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelSearch = useRef<HTMLInputElement>(null);
  const groups: Group[] = state.groups;
  const currentGroup = groups.find((g) => g.id === state.current?.provider);
  const currentModel = currentGroup?.models.find(
    (m) => m.id === state.current?.model,
  );
  const effort =
    state.current?.reasoningEffort ?? currentModel?.reasoning?.defaultEffort;
  const effortLabel =
    currentModel?.reasoning?.efforts.find((e) => e.id === effort)?.name ??
    state.retainedEffort ??
    effort ??
    "默认";
  const provider = submenu && submenu !== "effort" ? submenu.provider : null;
  const selectedGroup = groups.find((g) => g.id === provider);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (value: string, q: string) =>
    value.toLocaleLowerCase().includes(q);
  const filtered = groups
    .map((g) => ({
      ...g,
      models: matches(`${g.name} ${g.id}`, needle)
        ? g.models
        : g.models.filter((m) => matches(`${m.name} ${m.id}`, needle)),
    }))
    .filter((g) => g.models.length);
  const models = (filtered.find((g) => g.id === provider)?.models ?? []).filter(
    (m) => matches(`${m.name} ${m.id}`, modelQuery.trim().toLocaleLowerCase()),
  );
  const busy = state.status === "selecting" || Boolean(state.pending);
  const close = () => {
    setOpen(false);
    setSubmenu(null);
    trigger.current?.focus();
  };
  const closeSubmenu = () => {
    setSubmenu(null);
    anchor.current?.focus();
  };
  const openSubmenu = (
    value: { provider: string } | "effort",
    button: HTMLButtonElement,
  ) => {
    anchor.current = button;
    setModelQuery("");
    setSubPosition({ visibility: "hidden" });
    setSubmenu(value);
  };
  const choose = async (selection: any) => {
    setError(null);
    try {
      const result = await select(selection);
      if (!result?.ok)
        throw new Error(result?.error?.message ?? "无法切换模型，请重试");
      close();
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menu.current?.contains(target) &&
        !child.current?.contains(target) &&
        !trigger.current?.contains(target)
      ) {
        setOpen(false);
        setSubmenu(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (locked || !available) {
      setOpen(false);
      setSubmenu(null);
    }
  }, [locked, available]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r || !menu.current) return;
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const above = r.top - top - 10;
      const below = top + height - r.bottom - 10;
      const useAbove = above >= Math.min(360, below);
      setPosition({
        left: Math.max(
          left + 12,
          Math.min(r.left, left + width - menu.current.offsetWidth - 12),
        ),
        maxHeight: Math.max(100, Math.min(460, (useAbove ? above : below) - 8)),
        ...(useAbove
          ? { bottom: window.innerHeight - r.top + 6 }
          : { top: r.bottom + 6 }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !submenu) return;
    const place = () => {
      if (!anchor.current?.isConnected || !child.current || !menu.current) {
        setSubmenu(null);
        return;
      }
      const row = anchor.current.getBoundingClientRect();
      const parent = menu.current.getBoundingClientRect();
      if (row.bottom < parent.top || row.top > parent.bottom) {
        setSubmenu(null);
        return;
      }
      const viewport = window.visualViewport;
      const minX = (viewport?.offsetLeft ?? 0) + 12;
      const maxX = minX + (viewport?.width ?? window.innerWidth) - 24;
      const minY = (viewport?.offsetTop ?? 0) + 12;
      const maxY = minY + (viewport?.height ?? window.innerHeight) - 24;
      const width = child.current.offsetWidth;
      const rightSpace = maxX - parent.right - 6;
      const leftSpace = parent.left - minX - 6;
      // Keep both cards mounted; flip to the left when the right edge is tight.
      const right = rightSpace >= width || rightSpace >= leftSpace;
      const x = right ? parent.right + 6 : parent.left - width - 6;
      const height = Math.min(child.current.scrollHeight, 460, maxY - minY);
      setSubPosition({
        left: Math.max(minX, Math.min(x, maxX - width)),
        top: Math.max(minY, Math.min(row.top - 6, maxY - height)),
        maxHeight: Math.min(460, maxY - minY),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(child.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open, submenu]);
  useEffect(() => {
    if (open && position.visibility !== "hidden" && !submenu)
      search.current?.focus();
  }, [open, position.visibility]);
  useEffect(() => {
    if (!submenu || subPosition.visibility === "hidden") return;
    if (submenu === "effort")
      (
        child.current?.querySelector<HTMLButtonElement>(
          '[aria-checked="true"]',
        ) ??
        child.current?.querySelector<HTMLButtonElement>(
          '[role="menuitemradio"]',
        )
      )?.focus();
    else modelSearch.current?.focus();
  }, [submenu, subPosition.visibility]);
  const keys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const inChild = event.currentTarget === child.current;
    if (
      event.key === "Escape" ||
      (event.key === "ArrowLeft" &&
        inChild &&
        event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (submenu) closeSubmenu();
      else close();
      return;
    }
    if (event.key === "Tab") {
      const controls = [menu.current, child.current].flatMap((el) =>
        Array.from(
          el?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled)",
          ) ?? [],
        ),
      );
      const i = controls.indexOf(document.activeElement as HTMLElement);
      if (controls.length) {
        event.preventDefault();
        controls[
          (i + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        ].focus();
      }
      return;
    }
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)',
      ),
    );
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp"].includes(event.key) && rows.length) {
      event.preventDefault();
      rows[
        i < 0
          ? event.key === "ArrowDown"
            ? 0
            : rows.length - 1
          : (i + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
            rows.length
      ].focus();
    } else if (
      event.key === "Enter" &&
      (event.target === search.current || event.target === modelSearch.current)
    ) {
      event.preventDefault();
      rows[0]?.click();
    } else if (event.key === "ArrowRight" && i >= 0 && !inChild) {
      event.preventDefault();
      rows[i].click();
    } else if (["Home", "End"].includes(event.key) && i >= 0) {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    }
  };
  const searchBox = (local: boolean) => (
    <div className="yu-model-search">
      <input
        ref={local ? modelSearch : search}
        aria-label={local ? "搜索此提供方的模型" : "搜索提供方或模型"}
        placeholder={local ? "搜索此提供方的模型…" : "搜索提供方或模型…"}
        value={local ? modelQuery : query}
        onChange={(e) => {
          if (local) setModelQuery(e.target.value);
          else {
            setQuery(e.target.value);
            setSubmenu(null);
          }
        }}
      />
      {(local ? modelQuery : query) && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => {
            if (local) {
              setModelQuery("");
              modelSearch.current?.focus();
            } else {
              setQuery("");
              setSubmenu(null);
              search.current?.focus();
            }
          }}
        >
          ×
        </button>
      )}
    </div>
  );
  const errorStrip = (error || state.error) && (
    <div className="yu-model-error" role="alert">
      {error || state.error}
      <button
        type="button"
        onClick={() => {
          setError(null);
          load();
        }}
      >
        重新加载
      </button>
    </div>
  );
  if (!available) return null;
  return (
    <>
      <style>{css}</style>
      <button
        ref={trigger}
        type="button"
        className="yu-model-trigger"
        disabled={locked || busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="选择模型"
        title={`${currentGroup?.name ?? state.current?.provider ?? ""} / ${currentModel?.name ?? state.current?.model ?? "选择模型"}`}
        onClick={() => {
          if (open) close();
          else {
            setSubmenu(null);
            setQuery("");
            setError(null);
            setPosition({ visibility: "hidden" });
            setOpen(true);
            load();
          }
        }}
      >
        <span>{currentModel?.name ?? state.current?.model ?? "选择模型"}</span>
        <small>
          {busy ? "切换中…" : currentModel?.reasoning ? effortLabel : ""}
        </small>
        <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <>
            <div
              ref={menu}
              style={position}
              className="yu-model-menu yu-model-menu--root"
              role="dialog"
              aria-label="模型选择"
              onKeyDown={keys}
            >
              <div className="yu-model-head">
                <strong>选择提供方</strong>
                <button type="button" aria-label="关闭模型菜单" onClick={close}>
                  ×
                </button>
              </div>
              {searchBox(false)}
              {state.status === "loading" && (
                <div className="yu-model-status" role="status">
                  正在加载模型…
                </div>
              )}
              {state.routable === false && (
                <div className="yu-model-status" role="status">
                  当前模型暂不可用，请选择其他模型。
                </div>
              )}
              {!submenu && errorStrip}
              {state.failures?.length > 0 && (
                <div className="yu-model-status">
                  部分提供方加载失败：
                  {state.failures
                    .map((f: any) => f.provider ?? f.id ?? f.message)
                    .join("、")}
                  <button type="button" onClick={load}>
                    重试
                  </button>
                </div>
              )}
              <div
                className="yu-model-list"
                role="menu"
                aria-label="提供方"
                aria-busy={busy}
              >
                {filtered.map((g) => (
                  <button
                    type="button"
                    className="yu-model-row"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={provider === g.id}
                    key={g.id}
                    onClick={(e) =>
                      openSubmenu({ provider: g.id }, e.currentTarget)
                    }
                  >
                    <span>
                      {g.name}
                      {g.id !== g.name && <small>{g.id}</small>}
                    </span>
                    {state.current?.provider === g.id && (
                      <span aria-label="当前提供方">✓</span>
                    )}
                    <em>{g.models.length} 个模型</em>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
                {!filtered.length && state.status !== "loading" && (
                  <div className="yu-model-status" role="status">
                    {needle ? "没有匹配的模型" : "暂无可用模型"}
                  </div>
                )}
              </div>
              {currentModel?.reasoning && (
                <div className="yu-model-foot">
                  <button
                    type="button"
                    className="yu-model-row"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={submenu === "effort"}
                    onClick={(e) => openSubmenu("effort", e.currentTarget)}
                  >
                    <span>推理档位</span>
                    <em>{effortLabel}</em>
                    <span aria-hidden="true">›</span>
                  </button>
                </div>
              )}
            </div>
            {submenu && (
              <div
                ref={child}
                style={subPosition}
                className={`yu-model-menu yu-model-submenu${submenu === "effort" ? " yu-model-submenu--effort" : ""}`}
                role="dialog"
                aria-label={
                  submenu === "effort" ? "推理档位子菜单" : "模型子菜单"
                }
                onKeyDown={keys}
              >
                <div className="yu-model-head">
                  <strong>
                    {submenu === "effort"
                      ? "推理档位"
                      : (selectedGroup?.name ?? provider)}
                  </strong>
                  <button
                    type="button"
                    aria-label="关闭子菜单"
                    onClick={closeSubmenu}
                  >
                    ×
                  </button>
                </div>
                {submenu !== "effort" && searchBox(true)}
                {errorStrip}
                <div
                  className="yu-model-list"
                  role="menu"
                  aria-label={
                    submenu === "effort"
                      ? "推理档位"
                      : `${selectedGroup?.name ?? provider} 模型`
                  }
                  aria-busy={busy}
                >
                  {submenu === "effort" ? (
                    currentModel?.reasoning ? (
                      [
                        ...(currentModel.reasoning.defaultEffort === undefined
                          ? [{ id: undefined, name: "提供方默认" }]
                          : []),
                        ...currentModel.reasoning.efforts,
                      ].map((level) => (
                        <button
                          type="button"
                          className="yu-model-row"
                          role="menuitemradio"
                          aria-checked={effort === level.id}
                          disabled={busy}
                          key={level.id ?? "default"}
                          onClick={() =>
                            choose({
                              provider: state.current.provider,
                              model: state.current.model,
                              ...(level.id === undefined
                                ? {}
                                : { reasoningEffort: level.id }),
                            })
                          }
                        >
                          <span>{level.name}</span>
                          {effort === level.id && (
                            <span aria-hidden="true">✓</span>
                          )}
                        </button>
                      ))
                    ) : (
                      <div className="yu-model-status">
                        此模型没有可选推理档位
                      </div>
                    )
                  ) : (
                    models.map((m) => (
                      <button
                        type="button"
                        className="yu-model-row"
                        role="menuitemradio"
                        aria-checked={
                          state.current?.provider === provider &&
                          state.current?.model === m.id
                        }
                        disabled={busy}
                        key={m.id}
                        title={m.id}
                        onClick={() =>
                          choose({
                            provider,
                            model: m.id,
                            ...(state.current?.provider === provider &&
                            state.current?.model === m.id
                              ? state.current.reasoningEffort === undefined
                                ? {}
                                : {
                                    reasoningEffort:
                                      state.current.reasoningEffort,
                                  }
                              : m.reasoning?.defaultEffort === undefined
                                ? {}
                                : {
                                    reasoningEffort: m.reasoning.defaultEffort,
                                  }),
                          })
                        }
                      >
                        <span>
                          {m.name}
                          {m.name !== m.id && <small>{m.id}</small>}
                        </span>
                        {state.current?.provider === provider &&
                          state.current?.model === m.id && (
                            <span aria-hidden="true">✓</span>
                          )}
                      </button>
                    ))
                  )}
                  {submenu !== "effort" && !models.length && (
                    <div className="yu-model-status" role="status">
                      没有匹配的模型
                    </div>
                  )}
                </div>
              </div>
            )}
          </>,
          document.body,
        )}
    </>
  );
}

export function installModelMenu(root: any) {
  root.inject(["remote.session", "sessions"], (ctx: any) => {
    ctx.effect(() =>
      ctx.slots.inject("conversation.input.model", () =>
        ctx.slots.register(
          {
            name: "conversation.input.model",
            priority: -10,
            inject: (sessionId: string) => {
              const directory = ctx.modelDirectories.directoryFor(sessionId);
              const available =
                ctx.sessions.subagentAddress(sessionId) === undefined;
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => {});
                },
                select: (selection: any) =>
                  available
                    ? directory.select(selection)
                    : Promise.resolve(undefined),
              };
            },
          },
          ModelMenu,
        ),
      ),
    );
  });
}
