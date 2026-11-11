import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { initialRun, runReducer } from "../src/components/agent/run-state";
import { providerError } from "../src/lib/server/ai/openai-compatible";
import {
  describeModelError,
  READ_PAGE_EXCERPT_CHARS,
  READ_PAGE_NOTE,
  type ResearchModelClient,
  runResearch,
} from "../src/lib/server/research-agent";
import type { ResearchEvent } from "../src/lib/server/research-events";
import { COMPACT_CONTENT_CHARS, MAX_CONTENT_CHARS } from "../src/lib/server/research-tools";
import {
  type FakePage,
  fakeAgents,
  fakeDeps,
  lastToolResults,
  PAGES,
  scriptedClient,
  toolUse,
  URLS,
} from "./research-fakes";

/** Small free tiers: buys return less text and pages the model has read shrink in the history. */

const LONG = "Burr alignment matters more than burr size. ".repeat(250); // ~11,000 chars
const LONG_HTML = `<article><h1>Grinders</h1><p>${LONG}</p></article>`;
const pages = {
  ...PAGES,
  [URLS.grinders]: { ...(PAGES[URLS.grinders] as FakePage), html: LONG_HTML },
  [URLS.espresso]: {
    ...(PAGES[URLS.espresso] as FakePage),
    html: `<article><p>${LONG}</p></article>`,
  },
};

type Results = Record<string, Record<string, unknown>>;
/** The parsed tool_result contents of every user message, by tool_use_id. */
function allToolResults(messages: Anthropic.Beta.Messages.BetaMessageParam[]): Results {
  const out: Results = {};
  for (let i = 0; i < messages.length; i++) {
    Object.assign(out, lastToolResults(messages.slice(0, i + 1)));
  }
  return out;
}

async function run(provider?: "anthropic" | "groq") {
  let receiptA = "";
  const { client, requests } = scriptedClient([
    () => [toolUse("t1", "buy", { url: URLS.grinders, reason: "Grinder picks" })],
    (messages) => {
      receiptA = String(lastToolResults(messages).t1?.receiptId);
      return [toolUse("t2", "buy", { url: URLS.espresso, reason: "Dialing in" })];
    },
    () => [
      toolUse("t3", "dispute", { receipt_id: receiptA, reason: "other", note: "Check the bytes" }),
    ],
    () => [
      toolUse("t4", "finish", {
        answer: "Alignment beats size [1].",
        citations: [{ url: URLS.espresso, receiptId: "rcpt_test2", claim: "Alignment" }],
      }),
    ],
  ]);
  const agents = fakeAgents(pages);
  const events: ResearchEvent[] = [];
  const deps = { ...fakeDeps(client, agents), ...(provider ? { provider } : {}) };
  if (provider === "groq") deps.model = "openai/gpt-oss-120b";
  const summary = await runResearch(deps, { question: "Which grinder?", budgetCents: 25 }, (e) =>
    events.push(e),
  );
  return { summary, requests, agents, events };
}

describe("research agent: page text on small free tiers", () => {
  it("cuts bought text and shrinks pages already read for providers other than Anthropic", async () => {
    const { summary, requests, agents, events } = await run("groq");
    expect(summary.status).toBe("finished");

    // The latest buy result is intact, cut only to the smaller per-buy budget.
    const second = allToolResults(requests[1]?.messages ?? []).t1 ?? {};
    expect(second.shortened).toBeUndefined();
    expect(String(second.text).length).toBeGreaterThan(COMPACT_CONTENT_CHARS - 100);
    expect(String(second.text).length).toBeLessThan(COMPACT_CONTENT_CHARS + 20);
    expect(String(second.text)).toMatch(/\[truncated\]$/);

    // Once the model answered it, the first page shrinks to an excerpt; the second stays whole.
    const third = allToolResults(requests[2]?.messages ?? []);
    expect(third.t1).toMatchObject({ receiptId: "rcpt_test1", shortened: READ_PAGE_NOTE });
    expect(String(third.t1?.text).length).toBeLessThanOrEqual(READ_PAGE_EXCERPT_CHARS + 2);
    expect(third.t2?.shortened).toBeUndefined();
    expect(String(third.t2?.text).length).toBeGreaterThan(COMPACT_CONTENT_CHARS - 100);

    // Compaction runs once: a later request carries the same excerpt.
    expect(allToolResults(requests[3]?.messages ?? []).t1).toEqual(third.t1);

    // The dispute sends the exact bytes delivered, not the shortened history.
    expect(new TextDecoder().decode(agents.calls.disputes[0]?.content as Uint8Array)).toBe(
      LONG_HTML,
    );
    // Citations still work by receipt ID.
    const answer = events.find((e) => e.type === "answer");
    expect(answer).toMatchObject({ citations: [{ receiptId: "rcpt_test2" }] });
  });

  it("keeps Claude's history unchanged, with the full per-buy text", async () => {
    const { summary, requests } = await run();
    expect(summary.status).toBe("finished");
    const third = allToolResults(requests[2]?.messages ?? []);
    for (const result of [third.t1, third.t2]) {
      expect(result?.shortened).toBeUndefined();
      expect(String(result?.text).length).toBeGreaterThan(MAX_CONTENT_CHARS - 100);
    }
  });
});

describe("research agent: requests too large for the model", () => {
  const message = /free tier can't fit the pages bought so far/;

  it("maps a 413 to ai_request_too_large, whoever sent it", () => {
    const groq = providerError(
      413,
      JSON.stringify({
        error: {
          message:
            "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 8322",
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      }),
      undefined,
      { label: "Groq", apiKey: "gsk_test" },
    );
    const anthropic = Anthropic.APIError.generate(
      413,
      { type: "error", error: { type: "request_too_large", message: "Request exceeds the limit" } },
      undefined,
      new Headers(),
    );
    const openai = providerError(
      429,
      JSON.stringify({ error: { message: "Request too large for gpt-4.1 on tokens per min" } }),
      undefined,
      { label: "OpenAI", apiKey: "sk_test" },
    );
    for (const error of [groq, anthropic, openai]) {
      expect(describeModelError(error)).toEqual({
        code: "ai_request_too_large",
        message: expect.stringMatching(message),
      });
    }
    // Other upstream failures keep their codes.
    expect(describeModelError(providerError(503, "down", undefined, { label: "Groq" })).code).toBe(
      "ai_upstream",
    );
    expect(
      describeModelError(providerError(429, "slow down", undefined, { label: "Groq" })).code,
    ).toBe("ai_rate_limited");
  });

  it("ends the run with the new code, and the client shows its message", async () => {
    const client = {
      beta: {
        messages: {
          stream() {
            throw providerError(413, "request_too_large", undefined, { label: "Groq" });
          },
        },
      },
    } as unknown as ResearchModelClient;
    const events: ResearchEvent[] = [];
    const summary = await runResearch(
      { ...fakeDeps(client), provider: "groq" },
      { question: "Which grinder?", budgetCents: 25 },
      (e) => events.push(e),
    );
    expect(summary.status).toBe("failed");
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({
      code: "ai_request_too_large",
      message: expect.stringMatching(message),
    });
    const view = events.reduce(
      (v, event) => runReducer(v, { type: "event", event }),
      initialRun(25),
    );
    expect(view.error).toEqual({
      code: "ai_request_too_large",
      message: expect.stringMatching(message),
    });
  });
});
