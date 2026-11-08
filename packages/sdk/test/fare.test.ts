import type { AddressInfo } from "node:net";
import { AGENT_HEADER } from "@botfare/contracts";
import {
  CITATIONS_PATH,
  contentDigestSha256,
  DECLINES_PATH,
  DISPUTES_PATH,
  MAX_DISPUTE_CONTENT_BYTES,
} from "@botfare/contracts/fare";
import {
  type Ed25519PublicJwk,
  jwkThumbprint,
  verifySignedRequest,
} from "@botfare/contracts/web-bot-auth";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotFareApiError, createBotFareAgent } from "../src";
import { startStack } from "./harness";

let stack: Awaited<ReturnType<typeof startStack>>;
let botfare: { url: string; close: () => Promise<void> };
let thumbprint: string;
const received: Array<{
  path: string;
  body: Record<string, unknown>;
  verified: boolean;
  agentHeader: string | undefined;
}> = [];
/** What the fake answers the next dispute with. */
let disputeReply: { status: number; body: unknown } = { status: 200, body: {} };
let declineStatus = 202;

beforeAll(async () => {
  stack = await startStack();
  thumbprint = await jwkThumbprint(stack.publicJwk as Ed25519PublicJwk);
  const app = express().use(express.json({ limit: "2mb" }));
  app.post([DISPUTES_PATH, DECLINES_PATH, CITATIONS_PATH], async (req, res) => {
    const verified = await verifySignedRequest({
      authority: req.headers.host ?? "",
      headers: req.headers,
      resolveKey: (keyid) => (keyid === thumbprint ? (stack.publicJwk as Ed25519PublicJwk) : null),
    });
    received.push({
      path: req.path,
      body: req.body,
      verified: verified.ok,
      agentHeader: req.header(AGENT_HEADER),
    });
    if (!verified.ok) {
      res.status(401).json({ error: "unauthorized", message: verified.message });
      return;
    }
    if (req.path === DISPUTES_PATH) {
      res.status(disputeReply.status).json(disputeReply.body);
    } else if (req.path === DECLINES_PATH) {
      res.status(declineStatus).json({ ok: true });
    } else {
      res.status(202).json({ ok: true });
    }
  });
  botfare = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
});

afterAll(async () => {
  await botfare.close();
  await stack.stop();
});

const ARTICLE = "<h1>Burr grinders, explained</h1><p>The full article.</p>";

describe("paid results keep the delivered bytes", () => {
  it("exposes body bytes and receiptId, and the response still reads the same bytes", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const result = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
    expect(result.paid).toBe(true);
    expect(result.receiptId).toMatch(/^rcpt_/);
    expect(result.receiptId).toBe(result.receipt?.transaction);
    expect(new TextDecoder().decode(result.body ?? new Uint8Array())).toBe(ARTICLE);
    expect(await result.response.text()).toBe(ARTICLE);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("payment-response")).toBeTruthy();
    expect(result.response.url).toBe(`${stack.siteUrl}/articles/burr-basics`);
  });

  it("keeps no bytes past maxKeptBodyBytes, but still delivers the whole body", async () => {
    const agent = createBotFareAgent({
      agentKey: stack.agentKey,
      botfareUrl: botfare.url,
      maxKeptBodyBytes: 10,
    });
    const result = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
    expect(result.paid).toBe(true);
    expect(result.body).toBeNull();
    expect(await result.response.text()).toBe(ARTICLE);

    // Without a Content-Length (chunked), the body is read up to the limit and then streamed on.
    const chunked: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (res.status !== 200) return res;
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      const parts = [ARTICLE.slice(0, 8), ARTICLE.slice(8, 20), ARTICLE.slice(20)];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await res.arrayBuffer();
          for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        },
      });
      return new Response(stream, { status: res.status, headers });
    };
    const small = createBotFareAgent({
      agentKey: stack.agentKey,
      botfareUrl: botfare.url,
      maxKeptBodyBytes: 10,
      fetch: chunked,
    });
    const streamed = await small.fetch(`${stack.siteUrl}/articles/burr-basics`);
    expect(streamed.paid).toBe(true);
    expect(streamed.body).toBeNull();
    expect(await streamed.response.text()).toBe(ARTICLE);
    const roomy = createBotFareAgent({
      agentKey: stack.agentKey,
      botfareUrl: botfare.url,
      fetch: chunked,
    });
    const kept = await roomy.fetch(`${stack.siteUrl}/articles/burr-basics`);
    expect(new TextDecoder().decode(kept.body ?? new Uint8Array())).toBe(ARTICLE);
    expect(await kept.response.text()).toBe(ARTICLE);
  });

  it("leaves unpaid responses untouched, with no body or receipt ID", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const result = await agent.fetch(`${stack.siteUrl}/free`);
    expect(result).toMatchObject({ paid: false, receiptId: null, body: null });
    expect(await result.response.json()).toEqual({ free: true });
  });
});

describe("agent.dispute()", () => {
  it("sends a signed dispute with the exact bytes and returns the outcome", async () => {
    const agent = createBotFareAgent({
      agentKey: stack.agentKey,
      botfareUrl: botfare.url,
      signRequests: false, // publisher requests unsigned; BotFare API calls are signed regardless
    });
    const paid = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
    const outcome = {
      disputeId: "dsp_1",
      receiptId: paid.receiptId,
      status: "refunded",
      refundedCents: 3,
      verdict: {
        decision: "refund",
        confidence: 0.94,
        category: "stub_or_paywall",
        rationale: "A subscribe prompt instead of the article.",
        evidence: [],
      },
      message: "Refunded $0.03",
    };
    disputeReply = { status: 200, body: outcome };
    const from = received.length;
    const result = await agent.dispute({
      receiptId: paid.receiptId ?? "",
      reason: "stub_or_paywall",
      note: "Subscribe prompt instead of the article",
      content: paid.body ?? new Uint8Array(),
    });
    expect(result).toEqual(outcome);
    const [request] = received.slice(from);
    expect(request).toMatchObject({ path: DISPUTES_PATH, verified: true, agentHeader: "1" });
    expect(request?.body).toEqual({
      receiptId: paid.receiptId,
      reason: "stub_or_paywall",
      note: "Subscribe prompt instead of the article",
      contentBase64: Buffer.from(ARTICLE).toString("base64"),
    });
    const sent = Buffer.from(String(request?.body.contentBase64), "base64");
    expect(await contentDigestSha256(new Uint8Array(sent))).toBe(
      await contentDigestSha256(ARTICLE),
    );
  });

  it("returns an 'invalid' outcome even when BotFare answers 4xx", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    disputeReply = {
      status: 422,
      body: {
        disputeId: "dsp_2",
        receiptId: "rcpt_0123456789abcdef",
        status: "invalid",
        refundedCents: 0,
        verdict: null,
        message: "The content does not match the publisher's digest",
      },
    };
    const outcome = await agent.dispute({
      receiptId: "rcpt_0123456789abcdef",
      reason: "unrelated",
      content: "tampered",
    });
    expect(outcome.status).toBe("invalid");
  });

  it("throws BotFareApiError on a refusal without an outcome", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    disputeReply = {
      status: 429,
      body: { error: "rate_limited", message: "Too many disputes today" },
    };
    const error = await agent
      .dispute({ receiptId: "rcpt_0123456789abcdef", reason: "other", content: "x" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BotFareApiError);
    expect(error).toMatchObject({ status: 429 });
    expect((error as Error).message).toContain("Too many disputes today");
  });

  it("refuses content over the limit, and needs a BotFare URL", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    await expect(
      agent.dispute({
        receiptId: "rcpt_0123456789abcdef",
        reason: "other",
        content: new Uint8Array(MAX_DISPUTE_CONTENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    const previous = process.env.BOTFARE_URL;
    delete process.env.BOTFARE_URL;
    try {
      const noUrl = createBotFareAgent({ agentKey: stack.agentKey });
      await expect(
        noUrl.dispute({ receiptId: "rcpt_0123456789abcdef", reason: "other", content: "x" }),
      ).rejects.toBeInstanceOf(BotFareApiError);
    } finally {
      if (previous !== undefined) process.env.BOTFARE_URL = previous;
    }
  });
});

describe("agent.decline() and agent.reportCitations()", () => {
  it("sends a signed decline note, best effort", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const offer = await agent.getOffer(`${stack.siteUrl}/articles/burr-basics`);
    if (!offer) throw new Error("no offer");
    const from = received.length;
    const ok = await agent.decline(offer, {
      category: "too_expensive",
      reason: `  ${"A thin listicle for the price. ".repeat(20)}`,
    });
    expect(ok).toBe(true);
    const [request] = received.slice(from);
    expect(request).toMatchObject({ path: DECLINES_PATH, verified: true });
    expect(request?.body).toMatchObject({
      url: `${stack.siteUrl}/articles/burr-basics`,
      priceCents: 3,
      category: "too_expensive",
    });
    expect(String(request?.body.reason)).toHaveLength(300);

    declineStatus = 500;
    expect(await agent.decline(offer, { category: "other", reason: "No" })).toBe(false);
    declineStatus = 202;
    // Unreachable BotFare: still no throw.
    const offline = createBotFareAgent({
      agentKey: stack.agentKey,
      botfareUrl: "http://127.0.0.1:9",
    });
    expect(await offline.decline(offer, { category: "irrelevant", reason: "Off topic" })).toBe(
      false,
    );
  });

  it("reports citations, signed", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: botfare.url });
    const from = received.length;
    const ok = await agent.reportCitations({
      answerId: "ans_12345678",
      citations: [{ receiptId: "rcpt_0123456789abcdef", claim: "Burrs grind evenly" }],
    });
    expect(ok).toBe(true);
    expect(received.slice(from)).toEqual([
      expect.objectContaining({
        path: CITATIONS_PATH,
        verified: true,
        body: {
          answerId: "ans_12345678",
          citations: [{ receiptId: "rcpt_0123456789abcdef", claim: "Burrs grind evenly" }],
        },
      }),
    ]);
    // Invalid reports are not sent.
    expect(await agent.reportCitations({ answerId: "short", citations: [] })).toBe(false);
  });
});
