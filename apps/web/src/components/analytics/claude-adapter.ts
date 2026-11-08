"use client";

import type {
  AgAiEvent,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";

/** One NDJSON line from POST /api/publisher/analytics/ai (see `AiStreamLine` on the server). */
type StreamLine =
  | { event: AgAiEvent }
  | { complete: AgLlmResponse }
  | { error: { code: string; message: string } };

/** The assistant's own words when the server cannot run it, shown in the chat panel. */
function notice(id: string, text: string): AgLlmResponse {
  return {
    id,
    createdAt: Date.now(),
    status: "completed",
    output: [
      {
        id,
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text, annotations: [] }],
      },
    ],
  };
}

function noticeEvents(response: AgLlmResponse): AgAiEvent[] {
  const item = response.output[0];
  if (item?.type !== "message") return [];
  const text = item.content
    .map((part) => (part.type === "text" ? part.text : part.refusal))
    .join("");
  return [
    { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: item.id },
  ];
}

/**
 * AG Studio `AgLlmAdapter` for Claude. It runs in the browser but holds no key: each turn is
 * forwarded as-is to BotFare's server route, which calls Anthropic and streams back AG-UI events.
 * A missing key or a refused request becomes a short assistant message rather than a stack trace.
 */
export function claudeAdapter(options: { endpoint: string }): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, turn?: AgLlmExecuteTurnOptions): AgLlmResponseHandler {
      let resolve!: (response: AgLlmResponse) => void;
      let reject!: (error: Error) => void;
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A consumer that stops reading the stream may never await `complete`.
      void complete.catch(() => {});

      async function* run(): AsyncGenerator<AgAiEvent> {
        let finished = false;
        try {
          const res = await fetch(options.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: request.input,
              instructions: request.instructions,
              tools: request.tools,
              toolChoice: request.toolChoice,
              responseFormat: request.responseFormat,
            }),
            signal: turn?.signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => ({}))) as { message?: string };
            const message =
              res.status === 503
                ? `${body.message ?? "AI assistant needs an Anthropic key"}. Set \`ANTHROPIC_API_KEY\` on the server, then reload this page.`
                : (body.message ?? `The assistant is unavailable (HTTP ${res.status}).`);
            const response = notice(`notice_${Date.now()}`, message);
            yield* noticeEvents(response);
            finished = true;
            resolve(response);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = done ? "" : (lines.pop() ?? "");
            for (const raw of lines) {
              if (!raw.trim()) continue;
              const line = JSON.parse(raw) as StreamLine;
              if ("event" in line) yield line.event;
              else if ("complete" in line) {
                finished = true;
                resolve(line.complete);
              } else if ("error" in line) {
                finished = true;
                reject(new Error(line.error.message));
              }
            }
            if (done) break;
          }
          if (!finished) reject(new Error("The assistant stopped before finishing its answer."));
        } catch (error) {
          if (!finished) reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      const iterator = run();
      return { stream: { [Symbol.asyncIterator]: () => iterator }, complete };
    },
  };
}
