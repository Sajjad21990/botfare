import { z } from "zod";
import { clientIp, TokenBudget, TurnLimiter } from "../../../lib/server/ai-budget";
import { jsonError, readLimitedJson } from "../../../lib/server/http";
import { runResearch } from "../../../lib/server/research-agent";
import {
  DEFAULT_BUDGET_CENTS,
  MAX_BUDGET_CENTS,
  MAX_QUESTION_CHARS,
  MIN_BUDGET_CENTS,
  type ResearchAvailability,
  type ResearchEvent,
} from "../../../lib/server/research-events";
import {
  createResearchDeps,
  missingConfigMessage,
  researchConfig,
} from "../../../lib/server/research-runtime";
import { requireApiUser } from "../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  question: z.string().trim().min(3, "Ask a question").max(MAX_QUESTION_CHARS),
  budgetCents: z
    .number()
    .int()
    .min(MIN_BUDGET_CENTS)
    .max(MAX_BUDGET_CENTS)
    .default(DEFAULT_BUDGET_CENTS),
});

/** Runs per visitor (user and IP) per 10 minutes, one at a time, and a token budget for everyone. */
const RUNS_PER_WINDOW = 8;
const RUN_WINDOW_MS = 10 * 60 * 1000;
/** Reserved per run before it starts (weighted tokens), settled with what it really used. */
const RUN_TOKEN_RESERVATION = 60_000;

const globalForResearch = globalThis as typeof globalThis & {
  __botfareResearchLimits?: { runs: TurnLimiter; budget: TokenBudget; active: Set<string> };
};
globalForResearch.__botfareResearchLimits ??= {
  runs: new TurnLimiter(RUNS_PER_WINDOW, RUN_WINDOW_MS),
  budget: new TokenBudget(),
  active: new Set(),
};
const limits = globalForResearch.__botfareResearchLimits;

/** Whether the research agent can run here (the /agent page shows a notice when it cannot). */
export async function GET(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const config = researchConfig();
  const body: ResearchAvailability = config.ok
    ? { available: true, model: config.model }
    : { available: false, missing: config.missing, message: missingConfigMessage(config.missing) };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Runs the research agent for one question and streams what it does as Server-Sent Events
 * (`event: <type>` + `data: <ResearchEvent JSON>`), ending with a `done` event.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const config = researchConfig();
  if (!config.ok) {
    return Response.json(
      {
        error: "research_unavailable",
        message: missingConfigMessage(config.missing),
        missing: config.missing,
      },
      { status: 503 },
    );
  }
  const parsed = await readLimitedJson(request, bodySchema, 8_192);
  if (!parsed.ok) return parsed.response;

  const userKey = auth.user.id;
  if (limits.active.has(userKey)) {
    return jsonError(409, "run_in_progress", "A research run is already in progress.");
  }
  if (!limits.runs.allow(`${userKey}:${clientIp(request)}`)) {
    return jsonError(429, "rate_limited", "Too many research runs. Wait a few minutes.");
  }
  const spend = limits.budget.reserve(RUN_TOKEN_RESERVATION);
  if (!spend) {
    return jsonError(
      429,
      "budget_exhausted",
      "The demo's research agent has used its AI budget for now. Try again later.",
    );
  }

  const deps = createResearchDeps(config);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  const encoder = new TextEncoder();
  limits.active.add(userKey);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: ResearchEvent) => {
        if (!open) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          open = false;
        }
      };
      try {
        const summary = await runResearch(deps, parsed.data, emit, { signal: abort.signal });
        limits.budget.settle(spend, summary.weightedTokens);
      } finally {
        limits.active.delete(userKey);
        request.signal.removeEventListener("abort", onAbort);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed by a cancelled reader.
          }
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
