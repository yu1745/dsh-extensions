import { fetch as undiciFetch, ProxyAgent } from "undici";
const proxies = new Map<string, ProxyAgent>();
/** Bounded account/discovery requests; model streaming keeps the caller's signal. */
export async function providerFetch(
  url: string | URL,
  init: any = {},
  timeoutMs?: number,
) {
  const proxy =
    (new URL(url).hostname === "copilot.tencent.com"
      ? process.env.CODEBUDDY_PROXY
      : process.env.ANTIGRAVITY_PROXY) ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  let dispatcher;
  if (proxy) {
    dispatcher = proxies.get(proxy);
    if (!dispatcher) proxies.set(proxy, (dispatcher = new ProxyAgent(proxy)));
  }
  const signal = timeoutMs
    ? AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ])
    : init.signal;
  return undiciFetch(url, {
    ...init,
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  }) as any as Promise<Response>;
}
