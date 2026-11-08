import { contentDigestSha256 } from "@botfare/contracts/fare";
import {
  type AnswerManifest,
  answerManifestSchema,
  checkAnswerSource,
  publicJwk,
  RECEIPT_JWT_TYPE,
} from "@botfare/contracts/receipts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
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
  fakeStatement,
  lastToolResults,
  PAGES,
  SITE,
  scriptedClient,
  toolUse,
  URLS,
} from "./research-fakes";

/** The research agent's sources manifest: signed payment and delivery statements per citation. */

const GRINDERS_HTML = PAGES[URLS.grinders]?.html as string;
const ESPRESSO_HTML = PAGES[URLS.espresso]?.html as string;

function setup(agents = fakeAgents(), deliveryRetryMs = [1, 1, 1]) {
  const events: ResearchEvent[] = [];
  const emit = (event: ResearchEvent) => events.push(event);
  const state = createRunState(25);
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
    deliveryRetryMs,
  };
  const call = async (name: string, input: unknown) => {
    const outcome = await runTool(ctx, name, input, `toolu_${events.length}`);
    return { ...outcome, body: JSON.parse(outcome.content) as Record<string, unknown> };
  };
  const buyAndFinish = async () => {
    const bought = await call("buy", { url: URLS.grinders, reason: "Core source" });
    const receiptId = String(bought.body.receiptId);
    const finished = await call("finish", {
      answer: "Get the Burrwell 60 [1].",
      citations: [{ url: URLS.grinders, receiptId, claim: "It is the pick" }],
    });
    return { receiptId, finished };
  };
  return { agents, call, buyAndFinish };
}

describe("research run: the answer carries a sources manifest", () => {
  it("streams one source per citation with the payment, delivery and read digest", async () => {
    const model = scriptedClient([
      () => [
        toolUse("t1", "buy", { url: URLS.grinders, reason: "Answers the question" }),
        toolUse("t2", "buy", { url: URLS.espresso, reason: "Dialing in" }),
      ],
      (messages) => {
        const results = lastToolResults(messages);
        return [
          toolUse("t3", "finish", {
            answer: "Get the Burrwell 60 [1] and start at 18 g in, 36 g out [2].",
            citations: [
              { url: URLS.grinders, receiptId: results.t1?.receiptId, claim: "It is the pick" },
              { url: URLS.espresso, receiptId: results.t2?.receiptId, claim: "The recipe" },
            ],
          }),
        ];
      },
    ]);
    const events: ResearchEvent[] = [];
    await runResearch(
      fakeDeps(model.client),
      { question: "Which grinder and recipe?", budgetCents: 25 },
      (event) => events.push(event),
      { runId: "run_manifest_demo" },
    );

    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("no answer event");
    const manifest = answer.manifest as AnswerManifest;
    expect(answerManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.answerId).toBe("run_manifest_demo");
    expect(manifest.sources).toEqual([
      {
        url: URLS.grinders,
        receiptId: "rcpt_test1",
        claim: "It is the pick",
        payment: fakeStatement("payment", "rcpt_test1"),
        delivery: fakeStatement("delivery", "rcpt_test1"),
        readDigest: await contentDigestSha256(GRINDERS_HTML),
      },
      {
        url: URLS.espresso,
        receiptId: "rcpt_test2",
        claim: "The recipe",
        payment: fakeStatement("payment", "rcpt_test2"),
        delivery: fakeStatement("delivery", "rcpt_test2"),
        readDigest: await contentDigestSha256(ESPRESSO_HTML),
      },
    ]);
  });

  it("has no manifest when the answer cites nothing", async () => {
    const { call } = setup();
    const finished = await call("finish", { answer: "Nothing worth buying.", citations: [] });
    expect(finished.finished).toBeDefined();
    expect(finished.manifest).toBeNull();
  });
});

describe("sources manifest: delivery statements arrive just after delivery", () => {
  it("asks again until the delivery statement is there", async () => {
    const agents = fakeAgents(undefined, {
      statements: async (receiptId, lookup) => ({
        receiptId,
        payment: fakeStatement("payment", receiptId),
        delivery: lookup >= 2 ? fakeStatement("delivery", receiptId) : null,
        refund: null,
      }),
    });
    const { buyAndFinish } = setup(agents);
    const { receiptId, finished } = await buyAndFinish();
    expect(agents.calls.statements).toEqual([receiptId, receiptId, receiptId]);
    expect(finished.manifest?.sources[0]?.delivery).toBe(fakeStatement("delivery", receiptId));
  });

  it("gives up after a bounded number of lookups and sends delivery null", async () => {
    const agents = fakeAgents(undefined, {
      statements: async (receiptId) => ({
        receiptId,
        payment: fakeStatement("payment", receiptId),
        delivery: null,
        refund: null,
      }),
    });
    const { buyAndFinish } = setup(agents, [1, 1]);
    const { finished } = await buyAndFinish();
    expect(agents.calls.statements).toHaveLength(3);
    expect(finished.manifest?.sources[0]).toMatchObject({
      payment: expect.any(String),
      delivery: null,
      readDigest: await contentDigestSha256(GRINDERS_HTML),
    });
  });

  it("keeps the payment statement from the buy when BotFare cannot be read", async () => {
    const agents = fakeAgents(undefined, {
      statements: async () => {
        throw new Error("BotFare is unreachable");
      },
    });
    const { buyAndFinish } = setup(agents);
    const { receiptId, finished } = await buyAndFinish();
    expect(agents.calls.statements).toHaveLength(1);
    expect(finished.manifest?.sources).toEqual([
      expect.objectContaining({ payment: fakeStatement("payment", receiptId), delivery: null }),
    ]);
  });

  it("uses BotFare's payment statement when the receipt carried none, else leaves the source out", async () => {
    const fromLookup = setup(fakeAgents(undefined, { signedReceipts: false }));
    const looked = await fromLookup.buyAndFinish();
    expect(looked.finished.manifest?.sources[0]?.payment).toBe(
      fakeStatement("payment", looked.receiptId),
    );

    const unsigned = setup(
      fakeAgents(undefined, { signedReceipts: false, statements: async () => null }),
    );
    const { finished } = await unsigned.buyAndFinish();
    expect(finished.finished?.citations).toHaveLength(1);
    expect(finished.manifest).toMatchObject({ answerId: "run_0123456789", sources: [] });
  });
});

describe("sources manifest: checkable with BotFare's public key only", () => {
  it("passes checkAnswerSource: paid, delivered and the bytes read match", async () => {
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const jwks = {
      keys: [publicJwk({ ...(await exportJWK(privateKey)), kid: "rk_1", alg: "EdDSA" })],
    };
    const issuer = "https://botfare.test";
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT({ v: 1, iss: issuer, ...claims })
        .setProtectedHeader({ alg: "EdDSA", typ: RECEIPT_JWT_TYPE, kid: "rk_1" })
        .setIssuedAt()
        .sign(privateKey);
    const agents = fakeAgents(undefined, {
      sign: async (kind, receiptId, page) =>
        kind === "payment"
          ? sign({
              sub: receiptId,
              kind,
              payment: {
                scheme: "prepaid",
                network: "paypal:sandbox",
                asset: "USD",
                amount: "3",
                amountMicros: 30_000,
                publisherMicros: 28_500,
                feeMicros: 1_500,
                payTo: SITE.id,
                siteOrigin: SITE.origin,
                resource: page.url,
                payer: "ak_demo",
                payerThumbprint: null,
                signal: null,
                offerDigest: null,
                settledAt: new Date().toISOString(),
              },
            })
          : sign({
              sub: receiptId,
              kind,
              delivery: {
                contentDigest: await contentDigestSha256(page.html),
                contentLength: new TextEncoder().encode(page.html).length,
                contentType: "text/html",
                status: 200,
                attestedAt: new Date().toISOString(),
              },
            }),
    });
    const { finished } = await setup(agents).buyAndFinish();
    const source = finished.manifest?.sources[0];
    if (!source) throw new Error("no source");
    const check = await checkAnswerSource(source, jwks, { issuer });
    expect(check.paid).toMatchObject({ ok: true, amountMicros: 30_000 });
    expect(check.delivered.ok).toBe(true);
    expect(check.bytesMatch.ok).toBe(true);
  });
});
