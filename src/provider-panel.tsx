import React, { useEffect, useState } from "react";
export function ProviderPanel({ api }: { api: any }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({});
  async function refresh() {
    const r = await api.status();
    if (!r.ok) throw new Error(r.error.message);
    setData(r.value);
  }
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const r = await api.status();
        if (active) {
          if (r.ok) {
            setData(r.value);
          } else setError(r.error.message);
        }
      } catch {}
    };
    void poll();
    const t = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [api]);
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      if (!r.ok) throw new Error(r.error.message);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return error ? <p className="yu-warning">服务登录：{error}</p> : null;
  return (
    <section aria-label="服务登录">
      <h3>服务登录</h3>
      <p className="yu-muted">
        授权由 DSH 保存并自动刷新，模型、搜索和额度查询共用。
      </p>
      {error && (
        <p role="alert" className="yu-warning">
          {error}
        </p>
      )}
      <div className="yu-providers">
        {data.providers.map((p: any) => {
          const a = data.attempts.find((v: any) => v.provider === p.id),
            pending = a?.status === "pending";
          return (
            <article className="yu-row" key={p.id}>
              <div className="yu-heading">
                <strong>{p.name}</strong>
                <button
                  disabled={busy || pending}
                  onClick={() => action(() => api.loginStart(p.id))}
                >
                  {p.connected ? "重新登录" : "登录"}
                </button>
              </div>
              <p>
                {p.connected
                  ? `已连接${p.account ? ` · ${p.account}` : ""}`
                  : "未登录"}
              </p>
              <p className="yu-muted">
                {p.models} 个模型 ·{" "}
                {p.connected ? "自动刷新已启用" : "登录后可使用"}
              </p>
              {pending && (
                <>
                  <p className="yu-muted">等待登录完成…</p>
                  {a.notices.map((n: any, i: number) => (
                    <p key={i}>
                      {n.message}
                      {n.url && (
                        <>
                          {" "}
                          <a href={n.url} target="_blank" rel="noreferrer">
                            打开授权页面
                          </a>
                        </>
                      )}
                    </p>
                  ))}
                  {a.prompt && (
                    <div className="yu-controls">
                      <label>
                        {a.prompt.message}
                        {a.prompt.kind === "select" ? (
                          <select
                            value={answers[a.prompt.id] ?? ""}
                            onChange={(e) =>
                              setAnswers({
                                ...answers,
                                [a.prompt.id]: e.target.value,
                              })
                            }
                          >
                            <option value="" disabled>
                              请选择
                            </option>
                            {a.prompt.options.map((o: any) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={
                              a.prompt.kind === "secret" ? "password" : "text"
                            }
                            placeholder={a.prompt.placeholder}
                            value={answers[a.prompt.id] ?? ""}
                            onChange={(e) =>
                              setAnswers({
                                ...answers,
                                [a.prompt.id]: e.target.value,
                              })
                            }
                          />
                        )}
                      </label>
                      <button
                        disabled={busy || !answers[a.prompt.id]}
                        onClick={() =>
                          action(() =>
                            api.loginAnswer({
                              id: a.id,
                              promptId: a.prompt.id,
                              value: answers[a.prompt.id],
                            }),
                          )
                        }
                      >
                        继续
                      </button>
                    </div>
                  )}
                  <p>
                    <button
                      disabled={busy}
                      onClick={() => action(() => api.loginCancel(a.id))}
                    >
                      取消登录
                    </button>
                  </p>
                </>
              )}
              {a?.status === "failed" && (
                <p role="alert" className="yu-warning">
                  {a.error}
                </p>
              )}
              {a?.status === "authorized" && <p>登录成功</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
