import { describe, expect, it } from "vitest";
import type { ResearchEvent } from "../src/lib/server/research-events";
import {
  createRunState,
  htmlToText,
  type ResearchToolContext,
  remainingCents,
  runTool,
  toCatalogSource,
  validateFinish,
  wireListener,
} from "../src/lib/server/research-tools";
import { CATALOG, fakeAgents, ORIGIN, SITE, URLS } from "./research-fakes";

function setup(budgetCents: number) {
  const events: ResearchEvent[] = [];
  const emit = (event: ResearchEvent) => events.push(event);
  const state = createRunState(budgetCents);
  const agents = fakeAgents();
  const onWire = wireListener(state, emit);
  const ctx: ResearchToolContext = {
    state,
    sites: [SITE],
    agent: agents.create({ maxPerRequestCents: 10, onWire }),
    agentWithCap: (cents) => agents.create({ maxPerRequestCents: cents, onWire }),
    fetchCatalog: async () => CATALOG,
    emit,
    signal: new AbortController().signal,
  };
  const call = async (name: string, input: unknown, id = `toolu_${events.length}`) => {
    state.currentToolCallId = id;
    const outcome = await runTool(ctx, name, input, id);
    state.currentToolCallId = null;
    return { ...outcome, body: JSON.parse(outcome.content) as Record<string, unknown> };
  };
  return { ctx, state, events, agents, call };
}

describe("research tools", () => {
  it("lists only the site's own URLs from its free catalog", async () => {
    const { call, events } = setup(25);
    const result = await call("list_sources", {});
    expect(result.isError).toBeUndefined();
    const sites = result.body.sites as { articles: { url: string; priceCents: number }[] }[];
    expect(sites[0]?.articles.map((a) => a.url)).toContain(URLS.grinders);
    expect(events.find((e) => e.type === "sources")).toMatchObject({
      sources: [{ siteName: "Crema Notes", available: true }],
    });

    const offSite = toCatalogSource(SITE, {
      articles: [
        { url: "http://elsewhere.test/a", title: "Elsewhere" },
        { url: `${ORIGIN}/articles/ok`, title: "On site" },
      ],
    });
    expect(offSite.articles.map((a) => a.title)).toEqual(["On site"]);
    expect(toCatalogSource(SITE, { articles: "nope" }).error).toMatch(/expected shape/);
  });

  it("reads an offer for free and reports price and preview", async () => {
    const { call, events, state } = setup(25);
    const result = await call("get_offer", { url: URLS.grinders });
    expect(result.body).toMatchObject({
      priceCents: 3,
      title: "Choosing a home grinder under $200",
    });
    expect(state.spentCents).toBe(0);
    expect(events.find((e) => e.type === "offer")).toMatchObject({
      url: URLS.grinders,
      priceCents: 3,
      siteName: "Crema Notes",
    });
  });

  it("buys a page: readable text, a receipt, the spend and wire events on the tool call", async () => {
    const { call, events, state } = setup(25);
    const result = await call("buy", { url: URLS.grinders, reason: "Answers the question" }, "t1");
    expect(result.isError).toBeUndefined();
    expect(result.body).toMatchObject({ receiptId: "rcpt_test1", paidCents: 3 });
    expect(result.body.text).toContain("The Burrwell 60 is the pick & it steps finely.");
    expect(result.body.text).not.toContain("alert(1)");
    expect(state.spentCents).toBe(3);
    expect(events.find((e) => e.type === "payment")).toMatchObject({
      receiptId: "rcpt_test1",
      amountCents: 3,
      remainingCents: 22,
      siteName: "Crema Notes",
    });
    const wire = events.filter((e) => e.type === "wire");
    expect(wire.map((e) => e.type === "wire" && e.step.stage)).toEqual([
      "payment-required",
      "payment-required",
      "payment-signature",
      "payment-response",
    ]);
    expect(wire.every((e) => e.type === "wire" && e.toolCallId === "t1")).toBe(true);
    const signature = wire.find((e) => e.type === "wire" && e.step.stage === "payment-signature");
    expect(signature).toMatchObject({
      step: { jwsHeader: { alg: "EdDSA", typ: "x402-prepaid+jwt", kid: "key_demo" } },
    });

    const again = await call("buy", { url: URLS.grinders, reason: "Again" });
    expect(again.isError).toBe(true);
    expect(state.spentCents).toBe(3);
  });

  it("refuses a purchase the remaining budget cannot cover, without paying", async () => {
    const { call, events, state, agents } = setup(5);
    await call("buy", { url: URLS.grinders, reason: "Core source" });
    expect(remainingCents(state)).toBe(2);
    const fetchesBefore = agents.calls.fetch.length;
    const refused = await call("buy", { url: URLS.espresso, reason: "Dial-in steps" });
    expect(refused.isError).toBe(true);
    expect(refused.refused).toBe(true);
    expect(refused.body).toMatchObject({ refused: true, by: "budget" });
    expect(agents.calls.fetch.length).toBe(fetchesBefore);
    expect(state.spentCents).toBe(3);
    expect(events.filter((e) => e.type === "refusal")).toMatchObject([{ by: "budget" }]);
  });

  it("caps the SDK at the remaining budget when it is below the per-request cap", async () => {
    const { call, agents, state } = setup(8);
    await call("buy", { url: URLS.grinders, reason: "Core source" });
    await call("buy", { url: URLS.espresso, reason: "Dial-in steps" });
    expect(agents.calls.fetch.map((f) => f.cap)).toEqual([8, 5]);
    expect(state.spentCents).toBe(8);
    expect(remainingCents(state)).toBe(0);
    const empty = await call("buy", { url: URLS.burrs, reason: "Background" });
    expect(empty.body).toMatchObject({ refused: true, by: "budget" });
  });

  it("surfaces the SDK spend limit as a refusal: nothing signed, nothing spent", async () => {
    const { call, events, state } = setup(100);
    const result = await call("buy", { url: URLS.premium, reason: "Best roundup" }, "t9");
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ refused: true, by: "spend-limit" });
    expect(String(result.body.message)).toMatch(/per-request max of \$0\.10/);
    expect(state.spentCents).toBe(0);
    expect(events.find((e) => e.type === "refusal")).toMatchObject({
      toolCallId: "t9",
      by: "spend-limit",
      priceCents: 50,
    });
    expect(events.some((e) => e.type === "wire" && e.step.stage === "payment-signature")).toBe(
      false,
    );
  });

  it("reports a facilitator refusal and charges nothing", async () => {
    const { call, state } = setup(25);
    const result = await call("buy", { url: URLS.refused, reason: "Test" });
    expect(result.body).toMatchObject({ refused: true, by: "publisher" });
    expect(String(result.body.message)).toContain("daily_cap_exceeded");
    expect(state.spentCents).toBe(0);
  });

  it("records skips with the reason", async () => {
    const { call, events } = setup(25);
    await call("get_offer", { url: URLS.latte });
    const result = await call("skip", { url: URLS.latte, reason: "Latte art is off-topic" });
    expect(result.body).toMatchObject({ recorded: true });
    expect(events.find((e) => e.type === "decision")).toMatchObject({
      action: "skip",
      priceCents: 3,
      title: "Pouring your first latte-art heart",
      reason: "Latte art is off-topic",
    });
  });

  it("rejects invalid input and URLs off BotFare sites before touching the agent", async () => {
    const { call, agents } = setup(25);
    expect((await call("buy", { url: URLS.grinders })).isError).toBe(true);
    expect((await call("buy", { url: "http://evil.test/x", reason: "r" })).body.error).toMatch(
      /not on a BotFare site/,
    );
    expect((await call("get_offer", { url: "file:///etc/passwd" })).body.error).toMatch(
      /absolute http/,
    );
    expect((await call("get_offer", { url: URLS.grinders, extra: 1 })).isError).toBe(true);
    expect((await call("nope", {})).isError).toBe(true);
    expect(agents.calls.fetch).toEqual([]);
    expect(agents.calls.getOffer).toEqual([]);
  });

  it("accepts only citations of receipts obtained in this run, for their own URL", async () => {
    const { call, state } = setup(25);
    await call("buy", { url: URLS.grinders, reason: "Core source" });

    const unknown = validateFinish(state, {
      answer: "Buy the Burrwell 60 [1].",
      citations: [{ url: URLS.grinders, receiptId: "rcpt_made_up", claim: "Pick" }],
    });
    expect(unknown).toMatchObject({ ok: false });
    expect(!unknown.ok && unknown.message).toMatch(/not obtained in this run/);

    const wrongUrl = validateFinish(state, {
      answer: "x [1]",
      citations: [{ url: URLS.espresso, receiptId: "rcpt_test1", claim: "Pick" }],
    });
    expect(!wrongUrl.ok && wrongUrl.message).toMatch(/is for/);

    expect(validateFinish(state, { answer: "", citations: [] }).ok).toBe(false);

    const finished = await call("finish", {
      answer: "Buy the Burrwell 60 [1].",
      citations: [{ url: `${URLS.grinders}#top`, receiptId: "rcpt_test1", claim: "The pick" }],
    });
    expect(finished.finished).toEqual({
      answer: "Buy the Burrwell 60 [1].",
      citations: [
        {
          n: 1,
          url: URLS.grinders,
          title: "Choosing a home grinder under $200",
          claim: "The pick",
          receiptId: "rcpt_test1",
          amountCents: 3,
          siteId: SITE.id,
          siteName: "Crema Notes",
        },
      ],
    });
  });

  it("turns HTML into readable text", () => {
    const text = htmlToText(
      "<html><body><nav>Menu</nav><main><h2>Title</h2><p>One &amp; two&nbsp;three &#8212; four</p><ul><li>a</li><li>b</li></ul></main></body></html>",
    );
    expect(text).toBe("## Title\nOne & two three — four\n\n- a\n- b");
  });
});
