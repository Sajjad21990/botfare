import type { User } from "@botfare/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialRun, parseSse, runReducer } from "../src/components/agent/run-state";
import type { ResearchDeps } from "../src/lib/server/research-agent";
import type { ResearchEvent } from "../src/lib/server/research-events";
import {
  fakeAgents,
  fakeDeps,
  lastToolResults,
  type ScriptedTurn,
  scriptedClient,
  text,
  toolUse,
  URLS,
} from "./research-fakes";

vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/session", () => ({
  requireApiUser: async () => ({ user: { id: "usr_owner", email: "owner@example.test" } as User }),
}));

/** The route builds its dependencies here; tests swap in a scripted model and a fake agent. */
const deps = vi.hoisted(() => ({ current: null as ResearchDeps | null, configs: [] as unknown[] }));
vi.mock("../src/lib/server/research-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server/research-runtime")>();
  return {
    ...actual,
    createResearchDeps: (config: unknown) => {
      deps.configs.push(config);
      if (!deps.current) throw new Error("no fake deps set");
      return deps.current;
    },
  };
});

import { GET, POST } from "../src/app/api/research/route";
import { runResearch } from "../src/lib/server/research-agent";

const AGENT_KEY = "bfk_test_agent_key_never_shown_to_the_model";

function post(body: unknown): Request {
  return new Request("http://botfare.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readEvents(response: Response): Promise<ResearchEvent[]> {
  const { events, rest } = parseSse(`${await response.text()}\n\n`);
  expect(rest).toBe("");
  return events;
}

/** The demo story: catalog, three offers, a refused premium page, a skip, a purchase, an answer. */
const DEMO_SCRIPT: ScriptedTurn[] = [
  () => [text("Let me see what is on offer."), toolUse("t1", "list_sources", {})],
  () => [
    toolUse("t2", "get_offer", { url: URLS.premium }),
    toolUse("t3", "get_offer", { url: URLS.latte }),
    toolUse("t4", "get_offer", { url: URLS.grinders }),
  ],
  () => [
    toolUse("t5", "buy", { url: URLS.premium, reason: "The most thorough roundup" }),
    toolUse("t6", "skip", { url: URLS.latte, reason: "Latte art does not help pick a grinder" }),
    toolUse("t7", "buy", { url: URLS.grinders, reason: "Directly answers the grinder question" }),
  ],
  (messages) => {
    const results = lastToolResults(messages);
    return [
      toolUse("t8", "finish", {
        answer: "Get the Burrwell 60 [1].",
        citations: [
          { url: URLS.grinders, receiptId: results.t7?.receiptId, claim: "It is the pick" },
        ],
      }),
    ];
  },
];

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  vi.stubEnv("BOTFARE_AGENT_KEY", AGENT_KEY);
  vi.stubEnv("ANTHROPIC_MODEL", "");
  deps.current = null;
  deps.configs = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/research", () => {
  it("streams the run as Server-Sent Events, ending with a cited answer", async () => {
    const model = scriptedClient(DEMO_SCRIPT);
    const agents = fakeAgents();
    deps.current = fakeDeps(model.client, agents);

    const response = await POST(post({ question: "Which grinder under $200?", budgetCents: 25 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(response);
    const types = events.map((event) => event.type);

    expect(types[0]).toBe("run-started");
    expect(types.at(-1)).toBe("done");
    expect(events[0]).toMatchObject({
      budgetCents: 25,
      maxPerRequestCents: 10,
      maxToolCalls: 12,
      model: "claude-sonnet-5-5",
      agentKeyId: "key_demo",
    });
    expect(types).toContain("thinking");
    expect(types).toContain("text");

    // The premium page: refused by the SDK's 10¢ cap, before anything was signed.
    expect(events.find((e) => e.type === "refusal")).toMatchObject({
      toolCallId: "t5",
      by: "spend-limit",
      priceCents: 50,
    });
    // The latte-art page: skipped by judgement.
    expect(events.find((e) => e.type === "decision" && e.action === "skip")).toMatchObject({
      url: URLS.latte,
      reason: "Latte art does not help pick a grinder",
    });
    // The grinder page: paid, with its wire trace on the same tool call.
    const payment = events.find((e) => e.type === "payment");
    expect(payment).toMatchObject({ toolCallId: "t7", amountCents: 3, remainingCents: 22 });
    const stages = events
      .filter((e) => e.type === "wire" && e.toolCallId === "t7")
      .map((e) => e.type === "wire" && e.step.stage);
    expect(stages).toEqual(["payment-required", "payment-signature", "payment-response"]);

    expect(events.find((e) => e.type === "answer")).toMatchObject({
      answer: "Get the Burrwell 60 [1].",
      citations: [{ n: 1, url: URLS.grinders, receiptId: "rcpt_test1", amountCents: 3 }],
      spentCents: 3,
      budgetCents: 25,
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "finished",
      spentCents: 3,
      toolCalls: 8,
      receipts: 1,
    });

    // What the model was sent: tools, thinking, fallback, and never the agent key.
    expect(model.requests).toHaveLength(4);
    const first = model.requests[0];
    expect(first?.model).toBe("claude-sonnet-5-5");
    expect(first?.tools?.map((tool) => ("name" in tool ? tool.name : null))).toEqual([
      "list_sources",
      "get_offer",
      "buy",
      "skip",
      "finish",
    ]);
    expect(first?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(first?.fallbacks).toBe("default");
    expect(first?.tool_choice).toEqual({ type: "auto" });
    expect(JSON.stringify(model.requests)).not.toContain(AGENT_KEY);
    expect(JSON.stringify(events)).not.toContain(AGENT_KEY);
    expect(deps.configs).toMatchObject([{ ok: true, agentKey: AGENT_KEY }]);

    // The refusal went back to the model as an error result; the purchase as text + receipt.
    const third = lastToolResults(model.requests[3]?.messages ?? []);
    expect(third.t5).toMatchObject({ refused: true, by: "spend-limit" });
    expect(third.t7).toMatchObject({ receiptId: "rcpt_test1", paidCents: 3 });

    // The page folds the same events into its timeline, wire inspector and answer.
    const view = events.reduce(
      (state, event) => runReducer(state, { type: "event", event }),
      initialRun(25),
    );
    expect(view.status).toBe("finished");
    expect(view.spentCents).toBe(3);
    expect(view.wire.t7?.response?.decoded).toMatchObject({ transaction: "rcpt_test1" });
    expect(view.wire.t5?.signature).toBeUndefined();
    expect(view.entries.map((entry) => entry.kind)).toEqual([
      "note",
      "note",
      "sources",
      "note",
      "offer",
      "offer",
      "offer",
      "note",
      "decision",
      "refusal",
      "decision",
      "decision",
      "payment",
      "note",
    ]);
    expect(view.answer?.citations[0]?.receiptId).toBe("rcpt_test1");
  });

  it("asks the model to fix citations that name receipts it does not hold", async () => {
    const model = scriptedClient([
      () => [toolUse("t1", "buy", { url: URLS.grinders, reason: "Core" })],
      () => [
        toolUse("t2", "finish", {
          answer: "x [1]",
          citations: [{ url: URLS.grinders, receiptId: "rcpt_invented", claim: "c" }],
        }),
      ],
      (messages) => [
        toolUse("t3", "finish", {
          answer: "Burrwell 60 [1]",
          citations: [{ url: URLS.grinders, receiptId: "rcpt_test1", claim: "c" }],
        }),
        // A call after finish in the same turn is never run.
        toolUse("t4", "buy", { url: URLS.espresso, reason: String(messages.length) }),
      ],
    ]);
    const agents = fakeAgents();
    deps.current = fakeDeps(model.client, agents);
    const events = await readEvents(await POST(post({ question: "Which grinder?" })));
    const errors = events.filter((e) => e.type === "tool-error");
    expect(errors).toMatchObject([{ toolCallId: "t2", name: "finish" }]);
    expect(errors[0]?.type === "tool-error" && errors[0].message).toMatch(/not obtained/);
    expect(events.find((e) => e.type === "answer")).toMatchObject({
      citations: [{ receiptId: "rcpt_test1" }],
    });
    expect(agents.calls.fetch.map((f) => f.url)).toEqual([URLS.grinders]);
    expect(events.at(-1)).toMatchObject({ status: "finished", spentCents: 3 });
  });

  it("validates the request body", async () => {
    deps.current = fakeDeps(scriptedClient([]).client);
    const tooBig = await POST(post({ question: "Which grinder?", budgetCents: 500 }));
    expect(tooBig.status).toBe(400);
    const empty = await POST(post({ question: "" }));
    expect(empty.status).toBe(400);
  });
});

describe("missing keys", () => {
  it("answers 503 with a clear message when ANTHROPIC_API_KEY or BOTFARE_AGENT_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("BOTFARE_AGENT_KEY", "");
    const response = await POST(post({ question: "Which grinder?" }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string; missing: string[] };
    expect(body.error).toBe("research_unavailable");
    expect(body.missing).toEqual(["ANTHROPIC_API_KEY", "BOTFARE_AGENT_KEY"]);
    expect(body.message).toMatch(/ANTHROPIC_API_KEY and BOTFARE_AGENT_KEY/);
    expect(deps.configs).toEqual([]);

    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    const agentOnly = await (await POST(post({ question: "Which grinder?" }))).json();
    expect(agentOnly.missing).toEqual(["BOTFARE_AGENT_KEY"]);
    expect(agentOnly.message).toMatch(/pnpm seed/);

    const availability = await (await GET()).json();
    expect(availability).toMatchObject({ available: false, missing: ["BOTFARE_AGENT_KEY"] });
  });

  it("reports the model when the agent can run", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5-5");
    expect(await (await GET()).json()).toEqual({ available: true, model: "claude-opus-5-5" });
  });
});

describe("hard limits in the loop", () => {
  const collect = () => {
    const events: ResearchEvent[] = [];
    return { events, emit: (event: ResearchEvent) => events.push(event) };
  };

  it(`stops after 12 tool calls, and the last one has to be finish`, async () => {
    let n = 0;
    const offers: ScriptedTurn = () => [
      toolUse(`a${++n}`, "get_offer", { url: URLS.grinders }),
      toolUse(`a${++n}`, "get_offer", { url: URLS.espresso }),
    ];
    const model = scriptedClient(Array.from({ length: 14 }, () => offers));
    const agents = fakeAgents();
    const { events, emit } = collect();
    const summary = await runResearch(
      fakeDeps(model.client, agents),
      { question: "q", budgetCents: 25 },
      emit,
    );
    expect(summary).toMatchObject({ status: "stopped", toolCalls: 12 });
    expect(model.requests).toHaveLength(6);
    expect(agents.calls.getOffer).toHaveLength(11);
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "tool_limit" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "stopped" });
  });

  it("never runs tool calls from a turn cut off at max_tokens", async () => {
    const model = scriptedClient([
      () => ({
        content: [toolUse("t1", "buy", { url: URLS.grinders, reason: "Cut" })],
        stop_reason: "max_tokens",
      }),
      () => [text("Done.")],
      () => [text("Still no finish.")],
    ]);
    const agents = fakeAgents();
    const { events, emit } = collect();
    const summary = await runResearch(
      fakeDeps(model.client, agents),
      { question: "q", budgetCents: 25 },
      emit,
    );
    expect(agents.calls.fetch).toEqual([]);
    expect(summary.status).toBe("failed");
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "no_answer" });
  });

  it("stops at the time limit", async () => {
    const hanging = {
      beta: {
        messages: {
          stream: (_params: unknown, options: { signal: AbortSignal }) => ({
            async *[Symbol.asyncIterator]() {
              await new Promise((_resolve, reject) =>
                options.signal.addEventListener("abort", () => reject(options.signal.reason)),
              );
            },
            finalMessage: async () => {
              throw new Error("unreachable");
            },
          }),
        },
      },
    } as unknown as ResearchDeps["client"];
    const { events, emit } = collect();
    const summary = await runResearch(fakeDeps(hanging), { question: "q", budgetCents: 25 }, emit, {
      timeoutMs: 30,
    });
    expect(summary.status).toBe("stopped");
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "timeout" });
  });

  it("fails clearly when no BotFare sites are registered", async () => {
    const { events, emit } = collect();
    const summary = await runResearch(
      fakeDeps(scriptedClient([]).client, fakeAgents(), []),
      { question: "q", budgetCents: 25 },
      emit,
    );
    expect(summary.status).toBe("failed");
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "no_sources" });
  });
});

describe("which sites the agent may read", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, n));
  const rows = [
    {
      id: "site_b",
      name: "Copy",
      origin: "https://crema.example/",
      createdAt: at(3),
      ownerUserId: "usr_x",
    },
    {
      id: "site_a",
      name: "Crema",
      origin: "https://crema.example",
      createdAt: at(1),
      ownerUserId: "usr_pub",
    },
    {
      id: "site_meta",
      name: "Meta",
      origin: "http://169.254.169.254",
      createdAt: at(2),
      ownerUserId: "usr_me",
    },
    {
      id: "site_local",
      name: "Local",
      origin: "http://localhost:4000",
      createdAt: at(4),
      ownerUserId: "usr_pub",
    },
    {
      id: "site_mine",
      name: "Mine",
      origin: "https://mine.example",
      createdAt: at(5),
      ownerUserId: "usr_me",
    },
    {
      id: "site_mapped",
      name: "Mapped",
      origin: "http://[::ffff:127.0.0.1]:10000",
      createdAt: at(6),
      ownerUserId: "usr_me",
    },
    {
      id: "site_junk",
      name: "Judge test blog",
      origin: "https://example.com",
      createdAt: at(7),
      ownerUserId: "usr_pub",
    },
    { id: "site_bad", name: "Bad", origin: "not a url", createdAt: at(8), ownerUserId: "usr_me" },
  ];
  const me = { userId: "usr_me", email: "me@example.test" };

  it("reads the demo publisher and a real user's own sites, never other people's", async () => {
    const { selectSites } = await import("../src/lib/server/research-runtime");
    const trustedOrigins = ["https://crema.example", "http://localhost:4000"];
    expect(selectSites(rows, { production: false, trustedOrigins }).map((s) => s.id)).toEqual([
      "site_a",
      "site_local",
    ]);
    expect(
      selectSites(rows, { production: false, trustedOrigins, viewer: me }).map((s) => s.id),
    ).toEqual(["site_a", "site_meta", "site_local", "site_mine", "site_mapped"]);
    // In production, own sites on private hosts are dropped (IPv4-mapped IPv6 included).
    expect(
      selectSites(rows, { production: true, trustedOrigins, viewer: me }).map((s) => s.id),
    ).toEqual(["site_a", "site_local", "site_mine"]);
  });

  it("gives the shared judge personas only the demo publisher", async () => {
    const { selectSites } = await import("../src/lib/server/research-runtime");
    const { DEMO_PERSONAS } = await import("@botfare/contracts");
    const persona = { userId: "usr_pub", email: DEMO_PERSONAS.publisher.email };
    expect(
      selectSites(rows, {
        production: true,
        trustedOrigins: ["https://crema.example"],
        viewer: persona,
      }).map((s) => s.id),
    ).toEqual(["site_a"]);
  });

  it("trusts DEMO_ORIGIN and DEMO_PUBLIC_URL, or the local seed default outside production", async () => {
    const { researchTrustedOrigins } = await import("../src/lib/server/research-runtime");
    expect(researchTrustedOrigins({ NODE_ENV: "development" })).toEqual(["http://localhost:4000"]);
    expect(researchTrustedOrigins({ NODE_ENV: "production" })).toEqual([]);
    expect(
      researchTrustedOrigins({
        NODE_ENV: "production",
        DEMO_ORIGIN: "https://demo.example",
        DEMO_PUBLIC_URL: "https://crema.example/",
      }),
    ).toEqual(["https://demo.example", "https://crema.example"]);
  });
});
