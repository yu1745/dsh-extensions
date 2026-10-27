// Opt-in paid/network smoke test. Uses only synthetic content and a new session.
// Does not invoke codex CLI; credential file is read in memory, never logged.
import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import {
  windowTools,
  transformWindowPayload,
  callWindowBackend,
} from "../lib/openai-window-protocol.js";
if (process.env.DSH_TEST_OPENAI_WINDOWS !== "1")
  throw new Error(
    "Set DSH_TEST_OPENAI_WINDOWS=1 to authorize the live smoke test",
  );
const { tokens } = JSON.parse(
  await readFile(`${homedir()}/.codex/auth.json`, "utf8"),
);
const sessionId = randomUUID(),
  threadId = randomUUID(),
  model = process.env.DSH_TEST_OPENAI_MODEL || "gpt-6-astra";
const marker = "DSH_WINDOW_" + randomBytes(12).toString("hex"),
  path = "smoke-" + randomBytes(6).toString("hex") + ".txt";
const agentName = "/root";
const client = new OpenAI({
  apiKey: tokens.access_token,
  baseURL: "https://chatgpt.com/backend-api/codex",
  defaultHeaders: { "ChatGPT-Account-ID": tokens.account_id },
  timeout: 35000,
  maxRetries: 0,
});
const config = {
  baseURL: "https://chatgpt.com/backend-api/codex",
  apiKey: tokens.access_token,
  headers: { "ChatGPT-Account-ID": tokens.account_id },
  sessionId,
  agentName,
};
let completed = [];
async function phase(index, input, instructions) {
  let count = 0;
  const contextWindowId = randomUUID();
  for (let step = 0; step < 10; step++) {
    const payload = transformWindowPayload(
      {
        model,
        store: false,
        stream: true,
        instructions,
        input,
        tools: windowTools.map((t) => ({
          type: "function",
          ...t,
          strict: false,
        })),
        parallel_tool_calls: false,
      },
      {
        sessionId,
        threadId,
        agentName,
        windowId: `${threadId}:${index}`,
        windowNumber: index,
        contextWindowId,
      },
    );
    let response;
    for await (const event of await client.responses.create(payload)) {
      if (event.type === "response.completed") response = event.response;
      if (event.type === "response.failed" || event.type === "error")
        throw new Error("Responses stream failed");
    }
    if (!response) throw new Error("No completed response");
    input.push(...response.output);
    const calls = response.output.filter((x) => x.type === "function_call");
    for (const item of response.output)
      if (item.type === "message")
        for (const block of item.content || [])
          if (block.text) console.log("window", index, "model:", block.text);
    if (!calls.length)
      return response.output
        .filter((x) => x.type === "message")
        .flatMap((x) =>
          (x.content || []).filter((b) => b.text).map((b) => b.text),
        )
        .join("\n");
    for (const call of calls) {
      if (
        ![
          "notes_write_file",
          "notes_read_file",
          "notes_search_contents",
          "history_list_windows",
          "history_search_contents",
        ].includes(call.name)
      )
        throw new Error("Unexpected tool " + call.name);
      const args = JSON.parse(call.arguments);
      const result = await callWindowBackend(config, call.name, args);
      if (!result.encrypted_output) throw new Error("No encrypted output");
      console.log(
        "window",
        index,
        "tool",
        call.name,
        "HTTP 200 encrypted output",
      );
      completed.push(call.name);
      count++;
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: [
          {
            type: "encrypted_content",
            encrypted_content: result.encrypted_output,
          },
        ],
      });
    }
  }
  throw new Error("Tool loop exceeded bound");
}
console.log("Synthetic notes smoke test:", model, "note:", path);
await phase(
  0,
  [
    {
      role: "user",
      content: `Write exactly '${marker}' into note '${path}' with notes_write_file, then read the complete note with notes_read_file. Report WRITE_READ_OK=true only if it matches. Stop after verification.`,
    },
  ],
  "Perform the synthetic integration test with the provided notes tools. No other work.",
);
if (
  !completed.includes("notes_write_file") ||
  !completed.includes("notes_read_file")
)
  throw new Error("Write/read tools were not executed");
// A fresh context: the previous messages and the secret marker are deliberately absent.
const recovered = await phase(
  1,
  [
    {
      role: "user",
      content: `Fresh context window. Recover the note '${path}' with notes_read_file, then search using notes_search_contents for its entire recovered content under this exact path prefix. Return only a JSON object with boolean READ_OK and SEARCH_OK and string recovered_content verbatim for the synthetic test only. You were not given the note content in this request.`,
    },
  ],
  "Use actual tool results; never infer or fabricate a note. Report true only when retrieval proves it.",
);
if (!completed.includes("notes_search_contents"))
  throw new Error("Search tool was not executed");
const parsed = JSON.parse(recovered.replace(/^```(?:json)?\s*|\s*```$/g, ""));
if (
  parsed.recovered_content !== marker ||
  parsed.READ_OK !== true ||
  parsed.SEARCH_OK !== true
)
  throw new Error("Fresh-window read/search verification failed");
console.log(
  "Verified fresh-window read/search and exact synthetic content match: PASS",
);
console.log("Completed tool chain:", completed.join(" -> "));
