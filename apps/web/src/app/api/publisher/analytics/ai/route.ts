import Anthropic from "@anthropic-ai/sdk";
import {
  type AiStreamLine,
  aiTurnRequestSchema,
  anthropicConfig,
  MAX_BODY_BYTES,
  runAiTurn,
} from "../../../../../lib/server/analytics-ai";
import { jsonError, readJson } from "../../../../../lib/server/http";
import { requireApiUser } from "../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_KEY_MESSAGE = "AI assistant needs an Anthropic key";

/** Turns per user per window. One question can take a dozen agent turns. */
const TURN_LIMIT = 150;
const WINDOW_MS = 10 * 60 * 1000;
const turnLog = new Map<string, number[]>();

function allowTurn(userId: string, now = Date.now()): boolean {
  const recent = (turnLog.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= TURN_LIMIT) {
    turnLog.set(userId, recent);
    return false;
  }
  recent.push(now);
  turnLog.set(userId, recent);
  return true;
}

/** Whether the assistant can run (the dashboard shows a notice when it cannot). */
export async function GET(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const config = anthropicConfig();
  return Response.json(
    config
      ? { available: true, model: config.model }
      : { available: false, message: NO_KEY_MESSAGE },
  );
}

/**
 * One AG Studio Agent Framework turn: the browser adapter posts the framework's `AgLlmRequest`
 * (conversation, instructions, tool schemas); the reply is NDJSON, one `AiStreamLine` per line:
 * content events as Claude streams them, then `{ complete: AgLlmResponse }` (or `{ error }`).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const config = anthropicConfig();
  if (!config) return jsonError(503, "ai_unavailable", NO_KEY_MESSAGE);

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return jsonError(413, "too_large", "The conversation is too long");
  const parsed = await readJson(request, aiTurnRequestSchema);
  if (!parsed.ok) return parsed.response;
  if (!allowTurn(auth.user.id)) {
    return jsonError(429, "rate_limited", "Too many assistant requests. Wait a few minutes.");
  }

  const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 1, timeout: 110_000 });
  const encoder = new TextEncoder();
  const lines = runAiTurn(client, parsed.data, { model: config.model, signal: request.signal });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await lines.next();
      if (next.done) {
        controller.close();
        return;
      }
      const line: AiStreamLine = next.value;
      controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
