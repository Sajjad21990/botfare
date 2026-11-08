"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ResearchAvailability } from "@/lib/server/research-events";
import { initialRun, parseSse, runReducer } from "./run-state";

/** Posts a question to /api/research and folds the Server-Sent Events into a RunView. */
export function useResearchRun(defaultBudgetCents: number) {
  const [view, dispatch] = useReducer(runReducer, defaultBudgetCents, (budget) =>
    initialRun(budget),
  );
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async (question: string, budgetCents: number) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    dispatch({ type: "start", question, budgetCents });
    let response: Response;
    try {
      response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ question, budgetCents }),
        signal: abort.signal,
      });
    } catch {
      if (!abort.signal.aborted) {
        dispatch({ type: "failed", code: "network", message: "Could not reach the server." });
      }
      return;
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      dispatch({
        type: "failed",
        code: body?.error ?? `http_${response.status}`,
        message: body?.message ?? `The research agent answered HTTP ${response.status}.`,
      });
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let sawDone = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.type === "done") sawDone = true;
          dispatch({ type: "event", event });
        }
      }
    } catch {
      if (abort.signal.aborted) {
        dispatch({ type: "stopped" });
        return;
      }
    }
    if (!sawDone && !abort.signal.aborted) {
      dispatch({
        type: "failed",
        code: "stream_ended",
        message: "The connection closed before the run finished.",
      });
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "stopped" });
  }, []);

  return { view, start, stop };
}

/** GET /api/research once: whether the agent can run on this server. */
export async function fetchAvailability(): Promise<ResearchAvailability> {
  try {
    const response = await fetch("/api/research", { cache: "no-store" });
    if (!response.ok) {
      return { available: false, message: "Could not check whether the research agent is set up." };
    }
    return (await response.json()) as ResearchAvailability;
  } catch {
    return { available: false, message: "Could not reach the server." };
  }
}
