import { contentDigestSha256 } from "@botfare/contracts/fare";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declaredOffer } from "../src";
import { createAgent, siteConfig, sleep, startFakeBotFare, startPublisher } from "./helpers";

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(20);
  }
  throw new Error("timed out");
}

function receiptOf(res: Response): string {
  return decodePaymentResponseHeader(res.headers.get("payment-response") ?? "").transaction;
}

describe("Fare Court: declared offer and proof of delivery", () => {
  let botfare: Awaited<ReturnType<typeof startFakeBotFare>>;
  let site: Awaited<ReturnType<typeof startPublisher>>;
  let agent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    botfare = await startFakeBotFare();
    site = await startPublisher({
      botfareUrl: botfare.url,
      proofOfDelivery: { retryDelaysMs: [20, 20, 20] },
      offerTelemetry: false,
    });
    agent = await createAgent(botfare.ledger);
  });
  afterAll(async () => {
    await site.close();
    await botfare.close();
  });
  const attestedFor = (receiptId: string) =>
    botfare.attestations.find((attestation) => attestation.receiptId === receiptId);

  it("declares the offer in the requirements and settles with the server's declaration", async () => {
    // An agent that rewrites the declared offer in its echo still pays; settle gets the real one.
    const tampering: typeof fetch = async (input, init) => {
      const res = await agent.fetch(input, init);
      const header = res.headers.get("payment-required");
      if (!header) return res;
      const required = decodePaymentRequiredHeader(header);
      for (const accept of required.accepts) {
        accept.extra = { ...accept.extra, botfareOffer: { title: "Something else", preview: "" } };
      }
      const headers = new Headers(res.headers);
      headers.set("payment-required", encodePaymentRequiredHeader(required));
      return new Response(await res.arrayBuffer(), { status: res.status, headers });
    };
    const res = await agent.payingFetchWith(tampering)(`${site.url}/articles/burr-basics`);
    expect(res.status).toBe(200);
    expect(botfare.settled.at(-1)?.extra).toMatchObject({
      botfareOffer: {
        title: "Preview of /articles/burr-basics",
        preview: "Burr grinders crush beans between two abrasive surfaces...",
        wordCount: 1200,
      },
    });
  });

  it("attests the digest of the exact body delivered, after the response", async () => {
    const res = await agent.payingFetch(`${site.url}/articles/burr-basics`);
    const body = new Uint8Array(await res.arrayBuffer());
    const receiptId = receiptOf(res);
    expect(receiptId).toBe(botfare.ledger.receipts.at(-1)?.transaction);
    const attestation = await waitFor(() => attestedFor(receiptId));
    expect(attestation.body).toEqual({
      contentDigest: await contentDigestSha256(body),
      contentLength: body.length,
      contentType: "text/html; charset=utf-8",
      status: 200,
    });
  });

  it("hashes a body written in several chunks, strings with encodings and Buffers", async () => {
    const res = await agent.payingFetch(`${site.url}/articles/streamed`);
    const text = await res.text();
    expect(text).toBe("Part one. Part two, café. Part three.");
    const attestation = await waitFor(() => attestedFor(receiptOf(res)));
    expect(attestation.body.contentDigest).toBe(await contentDigestSha256(text));
    expect(attestation.body.contentLength).toBe(new TextEncoder().encode(text).length);
  });

  it("retries a failed attestation without holding up the response", async () => {
    await sleep(100); // let earlier attestations land first
    botfare.failNextAttestations(2);
    const res = await agent.payingFetch(`${site.url}/articles/retry-me`);
    expect(res.status).toBe(200);
    // The response is already here while the attestation is still being retried.
    expect(attestedFor(receiptOf(res))).toBeUndefined();
    const attestation = await waitFor(() => attestedFor(receiptOf(res)));
    expect(attestation.body.status).toBe(200);
  });

  it("never attests unpaid responses: 402s, free pages, failed handlers", async () => {
    await sleep(100);
    const before = botfare.attestations.length;
    expect((await agent.fetch(`${site.url}/articles/burr-basics`)).status).toBe(402);
    expect((await fetch(`${site.url}/articles/burr-basics`)).status).toBe(200); // human, free
    expect((await agent.payingFetch(`${site.url}/articles/broken`)).status).toBe(500);
    await sleep(150);
    expect(botfare.attestations.length).toBe(before);
  });
});

describe("Fare Advisor: offer telemetry", () => {
  it("batches offers shown (402s with a price), with no query strings", async () => {
    const botfare = await startFakeBotFare();
    const site = await startPublisher({
      botfareUrl: botfare.url,
      offerTelemetry: { flushMs: 50, batchSize: 3 },
    });
    const agent = await createAgent(botfare.ledger);
    try {
      await agent.fetch(`${site.url}/articles/burr-basics?email=someone@example.com`);
      // Reaching the batch size sends at once.
      await agent.fetch(`${site.url}/articles/a`);
      await agent.fetch(`${site.url}/Articles/B/`);
      const first = await waitFor(() => botfare.telemetry[0]);
      expect(first.events).toHaveLength(3);
      expect(first.events[0]).toMatchObject({
        path: "/articles/burr-basics",
        method: "GET",
        priceCents: 3,
        signal: "agent-header",
      });
      expect(first.events[2]?.path).toBe("/articles/b");
      expect(JSON.stringify(first)).not.toContain("example.com");

      // A single event goes out on the timer; paid and free requests are not offers.
      await fetch(`${site.url}/api/brew-ratio`);
      await agent.payingFetch(`${site.url}/articles/paid`);
      await fetch(`${site.url}/articles/free-sample`);
      const later = await waitFor(() =>
        botfare.telemetry.length > 1 ? botfare.telemetry : undefined,
      );
      const events = later.slice(1).flatMap((batch) => batch.events);
      expect(events).toEqual([
        expect.objectContaining({ path: "/api/brew-ratio", priceCents: 2 }),
        // The paying fetch's first, unpaid request was shown the offer.
        expect.objectContaining({ path: "/articles/paid", priceCents: 3 }),
      ]);
    } finally {
      await site.close();
      await botfare.close();
    }
  });

  it("never queues a path with a control character, so it cannot spoil a batch", async () => {
    const botfare = await startFakeBotFare();
    const site = await startPublisher({
      botfareUrl: botfare.url,
      offerTelemetry: { flushMs: 50, batchSize: 2 },
    });
    const agent = await createAgent(botfare.ledger);
    try {
      const poisoned = await agent.fetch(`${site.url}/articles/%00`);
      expect(poisoned.status).toBe(402);
      await agent.fetch(`${site.url}/articles/%0Abad`);
      await agent.fetch(`${site.url}/articles/a`);
      await agent.fetch(`${site.url}/articles/b`);
      const first = await waitFor(() => botfare.telemetry[0]);
      expect(first.events.map((event) => event.path)).toEqual(["/articles/a", "/articles/b"]);
    } finally {
      await site.close();
      await botfare.close();
    }
  });
});

describe("declaredOffer()", () => {
  const [rule] = siteConfig().pricing;
  if (!rule) throw new Error("no rule");
  it("uses the publisher's preview when there is one", () => {
    expect(
      declaredOffer(rule, { title: "Burr basics", excerpt: "Burrs...", wordCount: 900 }),
    ).toEqual({ title: "Burr basics", preview: "Burrs...", wordCount: 900 });
  });
  it("falls back to the rule's description", () => {
    expect(declaredOffer(rule, undefined)).toEqual({ title: "Full article", preview: "" });
    expect(declaredOffer({ ...rule, description: undefined }, undefined)).toEqual({
      title: "GET /articles/*",
      preview: "",
    });
  });
});
