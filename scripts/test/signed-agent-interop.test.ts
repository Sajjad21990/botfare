/**
 * Interop: the real agent SDK (@botfare/sdk, which signs with @botfare/contracts/web-bot-auth)
 * against the real publisher middleware (@botfare/express botfare(), which verifies with the same
 * module), over real HTTP. The fake BotFare serves the key directory in exactly the shape the web
 * app publishes (kid = thumbprint, botfare_key_id = ak_…), plus the site config and facilitator.
 */
import { AGENT_HEADER, DEFAULT_DETECTION, encodeAgentKey } from "@botfare/contracts";
import { jwkThumbprint } from "@botfare/contracts/web-bot-auth";
import {
  BOTFARE_SIGNAL_EXTRA,
  botfare,
  checkSignedAgent,
  SignatureDirectory,
} from "@botfare/express";
import { createBotFareAgent, type WireEvent } from "@botfare/sdk";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Listening,
  listen,
  SITE_ID,
  SITE_SECRET,
  siteConfig,
  startFakeBotFare,
} from "../../packages/express/test/helpers";

const KEY_ID = "ak_interop";

describe("signed agents: @botfare/sdk against botfare()", () => {
  let botfareApp: Awaited<ReturnType<typeof startFakeBotFare>>;
  let publisher: Listening;
  let agentKey: string;
  let thumbprint: string;

  beforeAll(async () => {
    // Standard level: an unsigned Node fetch would already pay on automation, so the signal tells
    // us the signature (not the heuristics) decided.
    botfareApp = await startFakeBotFare(
      siteConfig({ detection: { ...DEFAULT_DETECTION, level: "standard" } }),
    );
    const { publicJwk, privateJwk } = await generateAgentKeyPair();
    botfareApp.ledger.addKey({ keyId: KEY_ID, publicJwk, walletId: "owner" });
    botfareApp.ledger.topUp("owner", 100);
    agentKey = encodeAgentKey({ v: 1, keyId: KEY_ID, privateJwk } as Parameters<
      typeof encodeAgentKey
    >[0]);
    const jwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: publicJwk.x as string };
    thumbprint = await jwkThumbprint(jwk);
    // The same members apps/web/src/lib/server/agent-directory.ts publishes.
    botfareApp.setDirectoryKeys([{ ...jwk, kid: thumbprint, use: "sig", botfare_key_id: KEY_ID }]);

    const app = express();
    app.use(botfare({ siteId: SITE_ID, siteSecret: SITE_SECRET, botfareUrl: botfareApp.url }));
    app.get("/articles/:slug", (_req, res) => {
      res.json({ article: true, detection: res.locals.botfare });
    });
    publisher = await listen(app);
  });

  afterAll(async () => {
    await publisher?.close();
    await botfareApp?.close();
  });

  it("the SDK's keyid is the directory thumbprint", async () => {
    const agent = createBotFareAgent({ agentKey, botfareUrl: botfareApp.url });
    expect(await agent.signatureKeyId()).toBe(thumbprint);
  });

  it("getOffer is recognised as signed-agent and the 402 carries that signal", async () => {
    const wire: WireEvent[] = [];
    const agent = createBotFareAgent({
      agentKey,
      botfareUrl: botfareApp.url,
      onWire: (event) => wire.push(event),
    });
    const offer = await agent.getOffer(`${publisher.url}/articles/burr-basics`);
    expect(offer?.priceCents).toBe(3);
    const required = wire.find((event) => event.stage === "payment-required");
    expect(required?.stage).toBe("payment-required");
    if (required?.stage !== "payment-required") return;
    expect(required.decoded.accepts[0]?.extra?.[BOTFARE_SIGNAL_EXTRA]).toBe("signed-agent");

    // The same request unsigned is only agent-header.
    const raw = await fetch(`${publisher.url}/articles/burr-basics`, {
      headers: { [AGENT_HEADER]: "1" },
    });
    await raw.body?.cancel();
    const unsigned = decodePaymentRequiredHeader(raw.headers.get("PAYMENT-REQUIRED") ?? "");
    expect(unsigned.accepts[0]?.extra?.[BOTFARE_SIGNAL_EXTRA]).toBe("agent-header");
  });

  it("a paid fetch verifies on both legs, names the key and settles as signed-agent", async () => {
    const agent = createBotFareAgent({ agentKey, botfareUrl: botfareApp.url });
    const settledBefore = botfareApp.settled.length;
    const result = await agent.fetch(`${publisher.url}/articles/pour-over`);
    expect(result.response.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.receipt?.payer).toBe(KEY_ID);
    expect(result.offer?.priceCents).toBe(3);
    const body = (await result.response.json()) as {
      detection: { signal: string; reasons: string[] };
    };
    expect(body.detection.signal).toBe("signed-agent");
    expect(body.detection.reasons).toContain(`signed agent ${KEY_ID}`);
    const settled = botfareApp.settled.slice(settledBefore);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.extra?.[BOTFARE_SIGNAL_EXTRA]).toBe("signed-agent");
  });

  it("without signing the same agent falls back to agent-header", async () => {
    const agent = createBotFareAgent({ agentKey, botfareUrl: botfareApp.url, signRequests: false });
    const settledBefore = botfareApp.settled.length;
    const result = await agent.fetch(`${publisher.url}/articles/cold-brew`);
    expect(result.paid).toBe(true);
    const body = (await result.response.json()) as { detection: { signal: string } };
    expect(body.detection.signal).toBe("agent-header");
    expect(botfareApp.settled[settledBefore]?.extra?.[BOTFARE_SIGNAL_EXTRA]).toBe("agent-header");
  });

  it("an SDK signature replayed against another host is ignored", async () => {
    let captured: Headers | undefined;
    const agent = createBotFareAgent({
      agentKey,
      botfareUrl: botfareApp.url,
      fetch: async (input, init) => {
        captured = new Request(input, init).headers;
        return new Response(null, { status: 404 });
      },
    });
    await agent.getOffer("https://other-publisher.test/articles/x");
    expect(captured?.get("signature-input")).toContain('tag="web-bot-auth"');
    const directory = new SignatureDirectory({ botfareUrl: botfareApp.url });
    const req = (host: string) => ({
      method: "GET",
      originalUrl: "/articles/x",
      protocol: "https",
      get: (name: string) =>
        name.toLowerCase() === "host" ? host : (captured?.get(name) ?? undefined),
    });
    const now = Math.floor(Date.now() / 1000);
    expect(await checkSignedAgent(req("other-publisher.test"), directory, now)).toMatchObject({
      status: "valid",
      agentKeyId: KEY_ID,
    });
    expect(await checkSignedAgent(req("crema-notes.test"), directory, now)).toMatchObject({
      status: "invalid",
    });
  });
});
