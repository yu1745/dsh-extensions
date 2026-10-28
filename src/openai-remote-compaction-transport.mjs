// Standalone prototype: transport and validation only; no replay-window construction.
// The caller supplies a pre-authenticated header set and an injected fetch function.
const FEATURE = "remote_compaction_v2";
const DEFAULTS = Object.freeze({ timeoutMs: 35_000, maxBytes: 4 * 1024 * 1024, maxEventBytes: 512 * 1024, maxEvents: 10_000 });

export class RemoteCompactionError extends Error {
  constructor(code, status) {
    super(status === undefined ? `Remote compaction: ${code}` : `Remote compaction: ${code} (HTTP ${status})`);
    this.name = "RemoteCompactionError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const fail = (code) => { throw new RemoteCompactionError(code); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;

/** Append the v2 beta without discarding existing features or auth headers. */
export function compactionHeaders(input) {
  const headers = new Headers(input);
  const features = (headers.get("x-codex-beta-features") ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!features.includes(FEATURE)) features.push(FEATURE);
  headers.set("x-codex-beta-features", [...new Set(features)].join(","));
  // The captured provider request may have been zstd-compressed. This
  // transport constructs a new plain JSON body, so its length/encoding are
  // different and must never reuse those headers.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  return headers;
}

// Even a custom fetch/reader that ignores AbortSignal must not prevent timeout.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new RemoteCompactionError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RemoteCompactionError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** POST a stateless v2 Responses request, returning exactly one opaque checkpoint.
 * No response body, request content, URL, headers, or underlying error text is
 * included in thrown errors. The caller must classify input/auth failures.
 */
export async function requestRemoteCompaction({ endpoint, request, headers, fetch: fetcher, signal, limits = {} }) {
  if (typeof fetcher !== "function") fail("fetch-required");
  let url;
  try { url = new URL(endpoint); } catch { fail("invalid-endpoint"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail("invalid-endpoint");
  if (!object(request) || typeof request.model !== "string" || !request.model ||
      typeof request.instructions !== "string" || !Array.isArray(request.input) ||
      request.input.some(item => object(item) && item.type === "compaction_trigger")) fail("invalid-request");
  const config = { ...DEFAULTS, ...limits };
  if (!positive(config.timeoutMs) || !positive(config.maxBytes) || !positive(config.maxEventBytes) || !positive(config.maxEvents)) fail("invalid-limits");
  let body, requestHeaders;
  try {
    const { headers: _ignored, ...payload } = request;
    body = JSON.stringify({ ...payload, input: [...request.input, { type: "compaction_trigger" }] });
    requestHeaders = compactionHeaders(headers);
  } catch { fail("invalid-request"); }

  const controller = new AbortController();
  const onCancel = () => controller.abort("cancelled");
  if (signal?.aborted) onCancel();
  else signal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), config.timeoutMs);
  let reader;
  try {
    if (controller.signal.aborted) fail("cancelled");
    let response;
    try {
      response = await abortable(fetcher(url.href, { method: "POST", headers: requestHeaders, body, signal: controller.signal, redirect: "error" }), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) fail(controller.signal.reason);
      fail("transport-error");
    }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
      throw new RemoteCompactionError("http-error", status);
    }
    if (!response.body || typeof response.body.getReader !== "function") fail("missing-stream");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    let bytes = 0, eventBytes = 0, count = 0, pending = "", data = [];
    let checkpoint, responseId, usage, complete = false, done = false;

    const dispatch = () => {
      if (!data.length) { eventBytes = 0; return; }
      if (++count > config.maxEvents) fail("event-limit");
      const raw = data.join("\n");
      data = []; eventBytes = 0;
      if (raw === "[DONE]") { if (done) fail("invalid-stream"); done = true; return; }
      if (done || complete) fail("invalid-stream");
      let event;
      try { event = JSON.parse(raw); } catch { fail("invalid-event"); }
      if (!object(event) || typeof event.type !== "string") fail("invalid-event");
      if (event.type === "error" || event.type === "response.failed") fail("response-failed");
      if (event.type === "response.incomplete") fail("response-incomplete");
      if (event.type === "response.output_item.done") {
        if (!object(event.item)) fail("invalid-event");
        if (event.item.type === "compaction" || event.item.type === "compaction_summary") {
          if (checkpoint !== undefined) fail("duplicate-compaction");
          if (typeof event.item.encrypted_content !== "string" || !event.item.encrypted_content) fail("invalid-compaction");
          checkpoint = event.item; // Opaque; never canonicalize or decode it.
        } else {
          // The v2 contract in this client expects exactly one compaction item.
          // Never silently discard unexpected assistant or tool output.
          fail("unexpected-output-item");
        }
      }
      if (event.type === "response.completed" || event.type === "response.done") {
        const response = object(event.response) ? event.response : undefined;
        if (response?.status && response.status !== "completed") fail("response-incomplete");
        const id = typeof event.response_id === "string" ? event.response_id : response?.id;
        if (typeof id !== "string" || !id || checkpoint === undefined) fail("invalid-completion");
        if (response?.output !== undefined &&
            (!Array.isArray(response.output) || response.output.length !== 1 || JSON.stringify(response.output[0]) !== JSON.stringify(checkpoint)))
          fail("inconsistent-completion");
        responseId = id;
        const tokenUsage = event.token_usage ?? response?.usage;
        if (object(tokenUsage)) usage = tokenUsage;
        complete = true;
      }
    };
    const line = (value) => {
      eventBytes += encoder.encode(value).byteLength + 1;
      if (eventBytes > config.maxEventBytes) fail("event-size-limit");
      if (!value) return dispatch();
      if (value.startsWith(":")) return;
      const colon = value.indexOf(":");
      const field = colon < 0 ? value : value.slice(0, colon);
      let valuePart = colon < 0 ? "" : value.slice(colon + 1);
      if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
      if (field === "data") data.push(valuePart);
    };
    const drainLines = (final) => {
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const ch = pending[i];
        if (ch !== "\n" && ch !== "\r") continue;
        if (ch === "\r" && i === pending.length - 1 && !final) break;
        line(pending.slice(start, i));
        if (ch === "\r" && pending[i + 1] === "\n") i++;
        start = i + 1;
      }
      pending = pending.slice(start);
      if (pending.length > config.maxEventBytes) fail("event-size-limit");
      if (final && pending) { line(pending); pending = ""; }
      if (final) dispatch();
    };
    for (;;) {
      let chunk;
      try { chunk = await abortable(reader.read(), controller.signal); }
      catch { if (controller.signal.aborted) fail(controller.signal.reason); fail("stream-error"); }
      if (chunk.done) {
        try { pending += decoder.decode(); } catch { fail("invalid-utf8"); }
        drainLines(true);
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) fail("invalid-stream");
      bytes += chunk.value.byteLength;
      if (bytes > config.maxBytes) fail("stream-size-limit");
      try { pending += decoder.decode(chunk.value, { stream: true }); } catch { fail("invalid-utf8"); }
      drainLines(false);
      // [DONE] is the SSE terminal marker. Do not wait indefinitely for a
      // keep-alive socket to close, but still require a completed response.
      if (done) {
        if (!complete) fail("unfinished-stream");
        break;
      }
    }
    if (!complete) fail("unfinished-stream");
    return { compactionOutput: checkpoint, responseId, ...(usage ? { tokenUsage: usage } : {}) };
  } catch (error) {
    if (error instanceof RemoteCompactionError) throw error;
    if (controller.signal.aborted) fail(controller.signal.reason);
    fail("transport-error");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
    if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
  }
}
