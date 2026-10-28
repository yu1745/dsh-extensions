// Protocol reference: openai/codex aeb6b22c8bda5f4d4b6ab80ebd3ccdb3f47fb3ab,
// codex-rs/ext/history-notes/src/{tools,backend,extension}.rs and
// codex-rs/core/src/responses_metadata.rs. Flat names below are DSH aliases,
// not the server-reserved official notes/history namespaces.

type ObjectValue = Record<string, unknown>;
export interface WindowToolSchema {
  name: string;
  description: string;
  parameters: ObjectValue;
}
export interface WindowIdentity {
  sessionId: string;
  windowId: string;
  agentName: string;
  threadId?: string;
  windowNumber?: number;
  contextWindowId?: string;
  turnId?: string;
  installationId?: string;
}
export interface WindowBackendConfig {
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId: string;
  agentName: string;
  truncationPolicy?: { mode: "bytes" | "tokens"; limit: number };
}

const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (description: string): ObjectValue => ({
  type: "string",
  description,
});
const integer = (description: string): ObjectValue => ({
  type: "integer",
  description,
});
const boolean = (description: string): ObjectValue => ({
  type: "boolean",
  description,
});
const nullable = (schema: ObjectValue): ObjectValue => ({
  oneOf: [schema, { type: "null" }],
});
const agent = () =>
  nullable(
    string(
      "Agent name; omit for the current agent. Absolute or relative to the current agent.",
    ),
  );
const role = () =>
  nullable({
    type: "string",
    enum: ["user", "assistant", "tool", "system", "developer"],
  });
const filters = (): ObjectValue => ({
  limit: integer("Maximum number of items; at least 1."),
  recent_first: boolean("Return newest items first."),
  tool_namespace: nullable(
    string("Only this callable namespace; excludes non-tool messages."),
  ),
  role: role(),
  agent_name: agent(),
  tool_name: nullable(
    string("Only this callable tool; excludes non-tool messages."),
  ),
  window_id: nullable(
    string("Full opaque window ID; omit or null for all windows."),
  ),
});
const tool = (
  name: string,
  description: string,
  properties: ObjectValue,
  required?: string[],
): WindowToolSchema => ({
  name,
  description,
  parameters: { type: "object", properties, ...(required ? { required } : {}) },
});
const privateNotes =
  "Private recovery notes, not filesystem files. Relative paths use the current agent's notes directory; absolute paths use <agent_name>/notes/<path>. Empty, '.' and '..' components are unsupported. Keep each file below 1,000,000 UTF-8 bytes.";
const privateHistory =
  "Recover prior conversation after a window reset. History is read-only and eventually consistent; pass returned window and item IDs unchanged.";

// DSH's supported schema subset has oneOf, not anyOf, minimum or encrypted.
// Encryption annotations are restored only at the provider payload boundary.
export const windowTools: WindowToolSchema[] = [
  tool(
    "notes_write_file",
    `${privateNotes} Create or replace a note with the exact supplied text.`,
    {
      text: string("Complete replacement text for the file."),
      path: string("Virtual note file path."),
    },
    ["text", "path"],
  ),
  tool(
    "notes_append_to_file",
    `${privateNotes} Append text exactly as supplied; no implicit newline.`,
    {
      text: string("Text appended exactly as provided."),
      path: string("Virtual note file path."),
    },
    ["text", "path"],
  ),
  tool(
    "notes_read_file",
    `${privateNotes} Read all or a line range; successful writes are immediately readable.`,
    {
      path: string("Virtual note file path."),
      start_line: nullable(
        integer(
          "First line, inclusive and 1-based; negative counts backward from the final line.",
        ),
      ),
      stop_line: nullable(
        integer(
          "Last line, inclusive and 1-based; negative counts backward from the final line.",
        ),
      ),
    },
    ["path"],
  ),
  tool(
    "notes_list_files_by_prefix",
    `${privateNotes} List paths by prefix; listings are eventually consistent.`,
    {
      prefix: nullable(
        string("Note path prefix; omit for the current notes directory."),
      ),
      max_results: integer("Maximum number of files; at least 1."),
      file_order_by: {
        type: "string",
        enum: ["name", "created_at", "updated_at"],
      },
      file_order: { type: "string", enum: ["ascending", "descending"] },
    },
  ),
  tool(
    "notes_search_contents",
    `${privateNotes} Search lines by case-sensitive literal substring; searches are eventually consistent.`,
    {
      max_matches_per_file: integer(
        "Maximum matching lines per file; at least 1.",
      ),
      query: string("Case-sensitive literal substring to find in note lines."),
      recent_file_first: boolean("Order files by creation time, newest first."),
      max_files: integer("Maximum matching files; at least 1."),
      path_prefix: nullable(
        string("Note path prefix; omit for the current notes directory."),
      ),
    },
    ["query"],
  ),
  tool(
    "history_list_windows",
    `${privateHistory} List window ID and item-count pairs.`,
    {
      limit: integer("Maximum number of windows; at least 1."),
      agent_name: agent(),
      recent_first: boolean("Return newest windows first."),
    },
  ),
  tool(
    "history_list_items",
    `${privateHistory} List items with optional role, tool and window filters.`,
    {
      ...filters(),
      max_chars_per_item: integer(
        "Maximum characters in each truncated_content; at least 1.",
      ),
    },
  ),
  tool(
    "history_read_item",
    `${privateHistory} Read a bounded character range.`,
    {
      agent_name: agent(),
      item_id: string("Short item ID from the trailing [id: ...] marker."),
      offset_chars: integer("Zero-based character offset; at least 0."),
      limit_chars: integer("Maximum characters to return; at least 1."),
      window_id: string("Full opaque window ID containing the item."),
    },
    ["item_id", "window_id"],
  ),
  tool(
    "history_search_contents",
    `${privateHistory} Search item contents by case-sensitive literal substring.`,
    {
      ...filters(),
      query: string(
        "Case-sensitive literal substring to find in item content.",
      ),
    },
    ["query"],
  ),
];

const endpoints = new Map(
  windowTools.map(({ name }) => {
    const split = name.indexOf("_");
    return [
      name,
      `alpha/${name.slice(0, split)}/v2/${name.slice(split + 1)}`,
    ] as const;
  }),
);
endpoints.set("notes_thread_hint", "alpha/notes/v2/thread_hint");

export function endpointFor(name: string): string | undefined {
  return endpoints.get(name);
}

function sensitiveProperty(name: string): string | undefined {
  if (name === "notes_write_file" || name === "notes_append_to_file")
    return "text";
  if (name === "notes_search_contents" || name === "history_search_contents")
    return "query";
  return undefined;
}
function isWindowTool(name: unknown): name is string {
  return (
    typeof name === "string" &&
    endpoints.has(name) &&
    name !== "notes_thread_hint"
  );
}
function patchTool(value: unknown, namespace?: string): unknown {
  if (!object(value)) return value;
  if (
    value.type === "namespace" &&
    (value.name === "notes" || value.name === "history") &&
    Array.isArray(value.tools)
  ) {
    return {
      ...value,
      tools: value.tools.map((entry) => patchTool(entry, value.name as string)),
    };
  }
  const name = namespace ? `${namespace}_${value.name}` : value.name;
  if (!isWindowTool(name)) return value;
  const field = sensitiveProperty(name);
  if (
    !field ||
    !object(value.parameters) ||
    !object(value.parameters.properties)
  )
    return { ...value, strict: false };
  const properties = value.parameters.properties;
  if (!object(properties[field])) return { ...value, strict: false };
  return {
    ...value,
    strict: false,
    parameters: {
      ...value.parameters,
      properties: {
        ...properties,
        [field]: { ...properties[field], encrypted: true },
      },
    },
  };
}
function outputEnvelope(output: unknown): ObjectValue | undefined {
  // Only our exact transport marker can replace an output. Ordinary JSON text
  // (including a backend-looking encrypted_output key) remains untouched.
  let text = output;
  if (
    Array.isArray(output) &&
    output.length === 1 &&
    object(output[0]) &&
    output[0].type === "input_text"
  )
    text = output[0].text;
  if (typeof text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return object(parsed) &&
      parsed.dshOpenaiWindowOutput === 1 &&
      typeof parsed.encrypted_output === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
function encryptedOutput(envelope: ObjectValue): ObjectValue[] {
  const output: ObjectValue[] = [
    { type: "encrypted_content", encrypted_content: envelope.encrypted_output },
  ];
  if (envelope.images !== undefined) {
    if (!Array.isArray(envelope.images))
      throw new Error("History backend returned invalid image content.");
    for (const image of envelope.images) {
      if (
        !object(image) ||
        typeof image.data !== "string" ||
        typeof image.mime_type !== "string" ||
        (image.detail != null &&
          !["auto", "low", "high", "original"].includes(image.detail as string))
      ) {
        throw new Error("History backend returned invalid image content.");
      }
      output.push({
        type: "input_image",
        image_url: `data:${image.mime_type};base64,${image.data}`,
        ...(image.detail != null ? { detail: image.detail } : {}),
      });
    }
  }
  return output;
}

/** Patch transport-only fields without mutating, pruning or rebuilding history. */
export function transformWindowPayload<T>(
  payload: T,
  identity: WindowIdentity,
): T {
  if (!object(payload)) return payload;
  const metadata = object(payload.client_metadata)
    ? payload.client_metadata
    : {};
  let prior: ObjectValue = {};
  if (typeof metadata["x-codex-turn-metadata"] === "string") {
    try {
      const parsed: unknown = JSON.parse(metadata["x-codex-turn-metadata"]);
      if (object(parsed)) prior = parsed;
    } catch {
      /* Replace an invalid metadata blob; never touch input items. */
    }
  }
  const match = /^(.*):(\d+)$/.exec(identity.windowId);
  const windowNumber =
    identity.windowNumber ?? (match ? Number(match[2]) : undefined);
  const turnMetadata: ObjectValue = {
    ...prior,
    session_id: identity.sessionId,
    thread_id: identity.threadId ?? match?.[1] ?? identity.sessionId,
    agent_name: identity.agentName,
    window_id: identity.windowId,
    ...(Number.isSafeInteger(windowNumber) && windowNumber! >= 0
      ? { window_number: windowNumber }
      : {}),
    ...(identity.contextWindowId
      ? { context_window_id: identity.contextWindowId }
      : {}),
    ...(identity.turnId ? { turn_id: identity.turnId } : {}),
    ...(identity.installationId
      ? { installation_id: identity.installationId }
      : {}),
    request_kind: "turn",
    history_ingest_requested: true,
  };
  const recognizedCallIds = new Set<string>();
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (
        !object(item) ||
        item.type !== "function_call" ||
        typeof item.call_id !== "string"
      )
        continue;
      const name =
        item.namespace === "notes" || item.namespace === "history"
          ? `${item.namespace}_${item.name}`
          : item.name;
      if (isWindowTool(name)) recognizedCallIds.add(item.call_id);
    }
  }
  const input = Array.isArray(payload.input)
    ? payload.input.map((item) => {
        if (!object(item) || item.type !== "function_call_output") return item;
        const name =
          item.namespace === "notes" || item.namespace === "history"
            ? `${item.namespace}_${item.name}`
            : item.name;
        if (
          !isWindowTool(name) &&
          !(
            typeof item.call_id === "string" &&
            recognizedCallIds.has(item.call_id)
          )
        )
          return item;
        const envelope = outputEnvelope(item.output);
        return envelope ? { ...item, output: encryptedOutput(envelope) } : item;
      })
    : payload.input;
  return {
    ...payload,
    ...(Array.isArray(payload.tools)
      ? { tools: payload.tools.map((entry) => patchTool(entry)) }
      : {}),
    ...(Array.isArray(payload.input) ? { input } : {}),
    client_metadata: {
      ...metadata,
      session_id: identity.sessionId,
      thread_id: turnMetadata.thread_id,
      "x-codex-window-id": identity.windowId,
      ...(identity.turnId ? { turn_id: identity.turnId } : {}),
      ...(identity.installationId
        ? { "x-codex-installation-id": identity.installationId }
        : {}),
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    },
  } as T;
}

// A classified transport failure is advisory: it can disable future alpha
// transitions, but it never proves that an already-committed window is safe
// to discard or that the remote compaction service is available.
export class WindowBackendError extends Error {
  constructor(
    message: string,
    readonly kind: "cancelled" | "timeout" | "transport" | "http" | "protocol",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Call a Codex alpha notes/history endpoint. Never logs args, ciphertext or credentials. */
export async function callWindowBackend(
  config: WindowBackendConfig,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const endpoint = endpointFor(name);
  if (!endpoint) throw new Error("Unknown history or notes operation.");
  if (!object(args))
    throw new Error("History tool arguments must be a JSON object.");
  let url: URL;
  try {
    url = new URL(config.baseURL);
  } catch {
    throw new Error("Invalid history backend URL.");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid history backend URL.");
  let base = url.href.replace(/\/+$/, "").replace(/\/responses$/, "");
  // The selected provider already owns its API prefix. Only the public
  // ChatGPT shorthand needs Codex routing; API /v1 and custom proxies do not.
  if (
    url.hostname === "chatgpt.com" &&
    new URL(base).pathname === "/backend-api"
  )
    base += "/codex";
  const policy = config.truncationPolicy ?? { mode: "bytes", limit: 32_000 };
  if (
    !["bytes", "tokens"].includes(policy.mode) ||
    !Number.isSafeInteger(policy.limit) ||
    policy.limit <= 0
  )
    throw new Error("Invalid history output truncation policy.");
  const headers = new Headers(config.headers);
  headers.set("authorization", `Bearer ${config.apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("x-openai-tool-output-truncation-policy", JSON.stringify(policy));
  headers.delete("x-openai-encrypted-tool-arguments");
  if (sensitiveProperty(name))
    headers.set("x-openai-encrypted-tool-arguments", "true");
  const timeout = AbortSignal.timeout(35_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${base}/${endpoint}`, {
      method: "POST",
      headers,
      signal: combined,
      body: JSON.stringify({
        ...args,
        context: {
          session_id: config.sessionId,
          current_agent_name: config.agentName,
        },
      }),
      redirect: "error",
    });
  } catch {
    const kind = signal?.aborted
      ? "cancelled"
      : timeout.aborted
        ? "timeout"
        : "transport";
    throw new WindowBackendError(
      combined.aborted
        ? "History backend request was cancelled or timed out."
        : "History backend request failed.",
      kind,
    );
  }
  if (!response.ok)
    throw new WindowBackendError(
      `History backend request failed (HTTP ${response.status}).`,
      "http",
      response.status,
    );
  try {
    return await response.json();
  } catch {
    if (signal?.aborted)
      throw new WindowBackendError("History backend request was cancelled or timed out.", "cancelled");
    if (timeout.aborted)
      throw new WindowBackendError("History backend request was cancelled or timed out.", "timeout");
    throw new WindowBackendError("History backend returned invalid JSON.", "protocol");
  }
}
