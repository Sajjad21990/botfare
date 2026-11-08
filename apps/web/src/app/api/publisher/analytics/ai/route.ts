import Anthropic from "@anthropic-ai/sdk";
import {
  clientIp,
  estimateTokens,
  TokenBudget,
  TurnLimiter,
  weightedTokens,
} from "../../../../../lib/server/ai-budget";
import {
  type AiStreamLine,
  aiTurnRequestSchema,
  anthropicConfig,
  MAX_BODY_BYTES,
  runAiTurn,
} from "../../../../../lib/server/analytics-ai";
import { jsonError, readLimitedJson } from "../../../../../lib/server/http";
import { requireApiUser } from "../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_KEY_MESSAGE = "AI assistant needs an Anthropic key";

/** Per visitor (user and IP), and a spend budget across everyone: see lib/server/ai-budget. */
const globalForAi = globalThis as typeof globalThis & {
  __botfareAiLimits?: { turns: TurnLimiter; budget: TokenBudget };
};
globalForAi.__botfareAiLimits ??= { turns: new TurnLimiter(), budget: new TokenBudget() };
const limits = globalForAi.__botfareAiLimits;

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

  const parsed = await readLimitedJson(request, aiTurnRequestSchema, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  if (!limits.turns.allow(`${auth.user.id}:${clientIp(request)}`)) {
    return jsonError(429, "rate_limited", "Too many assistant requests. Wait a few minutes.");
  }
  const spend = limits.budget.reserve(estimateTokens(parsed.bytes));
  if (!spend) {
    return jsonError(
      429,
      "budget_exhausted",
      "The demo's assistant has used its AI budget for now. Try again later.",
    );
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
      if ("complete" in line) limits.budget.settle(spend, weightedTokens(line.complete.usage));
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
