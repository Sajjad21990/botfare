import { BotFareApiError } from "@botfare/sdk";
import { describe, expect, it } from "vitest";
import { initialRun, runReducer } from "../src/components/agent/run-state";
import { runResearch } from "../src/lib/server/research-agent";
import type { ResearchEvent } from "../src/lib/server/research-events";
import {
  createRunState,
  type ResearchToolContext,
  runTool,
  wireListener,
} from "../src/lib/server/research-tools";
import {
  CATALOG,
  fakeAgents,
  fakeDeps,
  lastToolResults,
  SITE,
  STUB_HTML,
  scriptedClient,
  toolUse,
  URLS,
} from "./research-fakes";

/** Fare Court and Fare Advisor in the research agent: decline notes, disputes, citation reports. */

function setup(budgetCents: number, agents = fakeAgents()) {
  const events: ResearchEvent[] = [];
  const emit = (event: ResearchEvent) => events.push(event);
  const state = createRunState(budgetCents);
  const onWire = wireListener(state, emit);
  const ctx: ResearchToolContext = {
    state,
    sites: [SITE],
    agent: agents.create({ maxPerRequestCents: 10, onWire }),
    agentWithCap: (cents) => agents.create({ maxPerRequestCents: cents, onWire }),
    fetchCatalog: async () => CATALOG,
    emit,
    signal: new AbortController().signal,
    answerId: "run_0123456789",
  };
  const call = async (name: string, input: unknown, id = `toolu_${events.length}`) => {
    const outcome = await runTool(ctx, name, input, id);
    return { ...outcome, body: JSON.parse(outcome.content) as Record<string, unknown> };
  };
  return { state, events, agents, call };
}

describe("research agent: skip sends a decline note", () => {
  it("tells the publisher why an offer was skipped, once, with the offered price", async () => {
    const { agents, call } = setup(25);
    await call("get_offer", { url: URLS.latte });
    const result = await call("skip", {
      url: URLS.latte,
      reason: "Latte art does not help pick a grinder",
      category: "irrelevant",
    });
    expect(result.body).toMatchObject({ recorded: true, publisherNoted: true });
    expect(agents.calls.declines).toEqual([
      {
        url: URLS.latte,
        priceCents: 3,
        input: { category: "irrelevant", reason: "Latte art does not help pick a grinder" },
      },
    ]);
    // A second skip of the same page, and a skip of a page never offered, send nothing.
    await call("skip", { url: URLS.latte, reason: "Still off-topic" });
    await call("skip", { url: URLS.burrs, reason: "Never looked at it" });
    expect(agents.calls.declines).toHaveLength(1);
  });

  it("records the skip even when BotFare does not take the note", async () => {
    const { call } = setup(25, fakeAgents(undefined, { notesAccepted: false }));
    await call("get_offer", { url: URLS.premium });
    const result = await call("skip", { url: URLS.premium, reason: "50¢ is too much" });
    expect(result.isError).toBeUndefined();
    expect(result.body).toMatchObject({ recorded: true, publisherNoted: false });
  });
});

describe("research agent: disputes (Fare Court)", () => {
  it("disputes a stub with the exact delivered bytes and gets the fare back", async () => {
    const { state, events, agents, call } = setup(25);
    const bought = await call("buy", { url: URLS.stub, reason: "A maintenance guide" }, "t1");
    const receiptId = String(bought.body.receiptId);
    expect(state.spentCents).toBe(3);

    const result = await call(
      "dispute",
      {
        receipt_id: receiptId,
        reason: "stub_or_paywall",
        note: "Promised a step-by-step guide; got a subscribe prompt",
      },
      "t2",
    );
    expect(result.isError).toBeUndefined();
    expect(result.body).toMatchObject({
      receiptId,
      status: "refunded",
      refundedCents: 3,
      citable: false,
      budget: { spentCents: 0, remainingCents: 25 },
    });
    expect(agents.calls.disputes).toHaveLength(1);
    expect(new TextDecoder().decode(agents.calls.disputes[0]?.content as Uint8Array)).toBe(
      STUB_HTML,
    );
    expect(events.filter((e) => e.type.startsWith("dispute"))).toEqual([
      expect.objectContaining({
        type: "dispute-filed",
        toolCallId: "t2",
        receiptId,
        url: URLS.stub,
        amountCents: 3,
        reason: "stub_or_paywall",
      }),
      expect.objectContaining({
        type: "dispute-outcome",
        toolCallId: "t2",
        receiptId,
        status: "refunded",
        refundedCents: 3,
        spentCents: 0,
        remainingCents: 25,
        verdict: expect.objectContaining({ decision: "refund", confidence: 0.94 }),
      }),
    ]);

    // Once disputed: not again, and not citable.
    const again = await call("dispute", {
      receipt_id: receiptId,
      reason: "stub_or_paywall",
      note: "Again",
    });
    expect(again.isError).toBe(true);
    const finish = await call("finish", {
      answer: "Clean the burrs [1].",
      citations: [{ url: URLS.stub, receiptId, claim: "Clean the burrs" }],
    });
    expect(finish.isError).toBe(true);
    expect(String(finish.body.error)).toMatch(/disputed/);
  });

  it("only disputes receipts from this run, and at most twice per run", async () => {
    const { call, agents } = setup(25);
    const foreign = await call("dispute", {
      receipt_id: "rcpt_someone_else",
      reason: "unrelated",
      note: "x",
    });
    expect(foreign.isError).toBe(true);
    const receipts: string[] = [];
    for (const url of [URLS.grinders, URLS.burrs, URLS.stub]) {
      receipts.push(String((await call("buy", { url, reason: "r" })).body.receiptId));
    }
    for (const receiptId of receipts.slice(0, 2)) {
      const result = await call("dispute", { receipt_id: receiptId, reason: "other", note: "n" });
      expect(result.body.status).toBe("refunded");
    }
    const third = await call("dispute", { receipt_id: receipts[2], reason: "other", note: "n" });
    expect(third.isError).toBe(true);
    expect(String(third.body.error)).toMatch(/At most 2 disputes/);
    expect(agents.calls.disputes).toHaveLength(2);
  });

  it("reports a dispute BotFare cannot take as failed, and keeps the spend", async () => {
    const agents = fakeAgents(undefined, {
      dispute: async () => {
        throw new BotFareApiError(429, "BotFare refused /api/disputes: Too many disputes today");
      },
    });
    const { state, events, call } = setup(25, agents);
    const bought = await call("buy", { url: URLS.stub, reason: "r" });
    const result = await call("dispute", {
      receipt_id: bought.body.receiptId,
      reason: "stub_or_paywall",
      note: "n",
    });
    expect(result.isError).toBe(true);
    expect(state.spentCents).toBe(3);
    expect(events.at(-1)).toMatchObject({
      type: "dispute-outcome",
      status: "failed",
      refundedCents: 0,
      message: expect.stringContaining("Too many disputes today"),
    });
  });

  it("keeps a denied page citable and the fare spent", async () => {
    const agents = fakeAgents(undefined, {
      dispute: async (input) => ({
        disputeId: "dsp_1",
        receiptId: input.receiptId,
        status: "denied",
        refundedCents: 0,
        verdict: {
          decision: "deny",
          confidence: 0.9,
          category: "not_as_described",
          rationale: "The article matches its title and preview.",
          evidence: [],
        },
        message: "No refund.",
      }),
    });
    const { state, call } = setup(25, agents);
    const bought = await call("buy", { url: URLS.grinders, reason: "r" });
    const receiptId = String(bought.body.receiptId);
    const result = await call("dispute", {
      receipt_id: receiptId,
      reason: "not_as_described",
      note: "n",
    });
    expect(result.body).toMatchObject({ status: "denied", refundedCents: 0, citable: true });
    expect(state.spentCents).toBe(3);
    const finish = await call("finish", {
      answer: "Get the Burrwell 60 [1].",
      citations: [{ url: URLS.grinders, receiptId, claim: "It is the pick" }],
    });
    expect(finish.finished).toBeDefined();
  });
});

describe("research run: stub → dispute → refund, then a cited answer", () => {
  it("streams the dispute, refunds the fare, reports citations and folds into the timeline", async () => {
    const model = scriptedClient([
      () => [toolUse("t1", "list_sources", {})],
      () => [toolUse("t2", "get_offer", { url: URLS.stub })],
      () => [toolUse("t3", "buy", { url: URLS.stub, reason: "A maintenance how-to" })],
      (messages) => {
        const bought = lastToolResults(messages).t3;
        expect(String(bought?.text)).toContain("Subscribe to keep reading");
        return [
          toolUse("t4", "dispute", {
            receipt_id: bought?.receiptId,
            reason: "stub_or_paywall",
            note: "The preview promised a maintenance guide; a subscribe prompt arrived",
          }),
          toolUse("t5", "buy", { url: URLS.grinders, reason: "Answers the question" }),
        ];
      },
      (messages) => {
        const results = lastToolResults(messages);
        expect(results.t4).toMatchObject({ status: "refunded", refundedCents: 3 });
        return [
          toolUse("t6", "finish", {
            answer: "Clean the burrs monthly; the Burrwell 60 is the pick [1].",
            citations: [
              { url: URLS.grinders, receiptId: results.t5?.receiptId, claim: "It is the pick" },
            ],
          }),
        ];
      },
    ]);
    const agents = fakeAgents();
    const events: ResearchEvent[] = [];
    const summary = await runResearch(
      fakeDeps(model.client, agents),
      { question: "How do I keep my grinder in shape?", budgetCents: 25 },
      (event) => events.push(event),
      { runId: "run_fare_court_demo" },
    );

    expect(summary).toMatchObject({ status: "finished", spentCents: 3, receipts: 2 });
    // The dispute costs nothing: only the article that was kept is spent.
    expect(events.find((e) => e.type === "answer")).toMatchObject({ spentCents: 3 });
    expect(agents.calls.citations).toEqual([
      {
        answerId: "run_fare_court_demo",
        citations: [{ receiptId: "rcpt_test2", claim: "It is the pick" }],
      },
    ]);
    // The system prompt tells the model when to dispute.
    expect(model.requests[0]?.system).toEqual(expect.stringContaining("call dispute"));

    // The /agent page's reducer shows one dispute entry that resolves to "refunded".
    let view = initialRun(25);
    for (const event of events) view = runReducer(view, { type: "event", event });
    const disputes = view.entries.filter((entry) => entry.kind === "dispute");
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({
      kind: "dispute",
      toolCallId: "t4",
      amountCents: 3,
      reason: "stub_or_paywall",
      outcome: { status: "refunded", refundedCents: 3 },
    });
    expect(view.spentCents).toBe(3);
  });
});
