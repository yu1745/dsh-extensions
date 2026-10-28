// Stateless /responses/compact transport. The caller provides the exact URL and
// headers captured from its authenticated Responses adapter; no credentials or
// remote bodies are included in errors. Output must be replayed in full.
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export class StandardCompactionError extends Error {
  constructor(code, status) {
    super(status === undefined ? `Remote compaction: ${code}` : `Remote compaction: ${code} (HTTP ${status})`);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const fail = (code, status) => { throw new StandardCompactionError(code, status); };
function awaitOrAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new StandardCompactionError(signal.reason));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new StandardCompactionError(signal.reason));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
function validOutput(output) {
  if (!Array.isArray(output) || !output.length || output.length > 10000) return false;
  let compactions = 0;
  for (const item of output) {
    if (!isObject(item)) return false;
    if (item.type === 'compaction') {
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content.length) return false;
      compactions++;
    } else {
      // Unknown variants are not discarded: fail before replacing the surface.
      if ((item.type !== undefined && item.type !== 'message') || item.role !== 'user' ||
          !(typeof item.content === 'string' || Array.isArray(item.content))) return false;
    }
  }
  return compactions === 1;
}
/** Returns the entire provider output, in order, without normalization. */
export async function requestStandardCompaction({ endpoint, headers, payload, fetch: fetcher, signal, timeoutMs = 300000, maxBytes = 16 * 1024 * 1024 }) {
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !isObject(payload) ||
      typeof payload.model !== 'string' || !payload.model || !Array.isArray(payload.input)) fail('invalid-request');
  let url, requestHeaders, body;
  try {
    url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !/\/responses\/?$/.test(url.pathname)) fail('invalid-endpoint');
    url.pathname = url.pathname.replace(/\/$/, '') + '/compact';
    requestHeaders = new Headers(headers);
    requestHeaders.delete('content-length'); requestHeaders.delete('content-encoding');
    requestHeaders.set('content-type', 'application/json'); requestHeaders.set('accept', 'application/json');
    const request = { model: payload.model, input: payload.input };
    if (payload.instructions !== undefined) request.instructions = payload.instructions;
    if (payload.prompt_cache_key !== undefined) request.prompt_cache_key = payload.prompt_cache_key;
    if (payload.service_tier !== undefined) request.service_tier = payload.service_tier;
    body = JSON.stringify(request);
  } catch (error) { if (error instanceof StandardCompactionError) throw error; fail('invalid-request'); }
  const controller = new AbortController();
  const cancel = () => controller.abort('cancelled');
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  let reader;
  try {
    if (controller.signal.aborted) fail('cancelled');
    let response;
    try { response = await awaitOrAbort(fetcher(url.href, { method: 'POST', headers: requestHeaders, body, redirect: 'error', signal: controller.signal }), controller.signal); }
    catch { if (controller.signal.aborted) fail(controller.signal.reason); fail('transport-error'); }
    if (!response?.ok) fail('http-error', Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined);
    if (!response.body || typeof response.body.getReader !== 'function') fail('missing-body');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      let next;
      try { next = await awaitOrAbort(reader.read(), controller.signal); }
      catch { if (controller.signal.aborted) fail(controller.signal.reason); fail('body-error'); }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) fail('invalid-body');
      size += next.value.length; if (size > maxBytes) fail('body-too-large'); chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let responseData;
    try { responseData = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid-body'); }
    if (!isObject(responseData) || responseData.object !== 'response.compaction' || !validOutput(responseData.output)) fail('invalid-output');
    return { output: responseData.output, ...(isObject(responseData.usage) ? { usage: responseData.usage } : {}) };
  } catch (error) {
    if (error instanceof StandardCompactionError) throw error;
    if (controller.signal.aborted) fail(controller.signal.reason);
    fail('transport-error');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
  }
}
