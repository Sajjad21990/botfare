import { createRequestSigner, type Ed25519PrivateJwk } from "@botfare/contracts/web-bot-auth";
import { createAgentKey, createUser, revokeAgentKey, seedWallet } from "@botfare/core";
import { generateAgentKeyPair, PrepaidPayPalClient } from "@botfare/x402-paypal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as receiptsRoute } from "../src/app/api/agent/receipts/route";
import { GET as walletRoute } from "../src/app/api/agent/wallet/route";
import { POST as settle } from "../src/app/api/x402/settle/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { resetFacilitator } from "../src/lib/server/facilitator";
import {
  facilitatorBody,
  makePublisher,
  postJson,
  requirementsFor,
  signPayment,
  useTestDatabase,
} from "./helpers";

const BOTFARE_URL = "http://botfare.test";
const savedEnv = {
  BOTFARE_URL: process.env.BOTFARE_URL,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
};

interface TestAgent {
  keyId: string;
  privateJwk: Ed25519PrivateJwk;
  client: PrepaidPayPalClient;
}

async function makeSigningAgent(label: string, limits: { daily?: number; perRequest?: number }) {
  const db = getDb();
  const tag = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await createUser(db, { email: `${tag}@example.test`, name: tag });
  const keys = await generateAgentKeyPair();
  const key = await createAgentKey(db, {
    ownerUserId: owner.id,
    name: `${label} agent`,
    publicJwk: keys.publicJwk,
    dailyCapCents: limits.daily ?? null,
    perRequestMaxCents: limits.perRequest ?? null,
  });
  await seedWallet(db, { ownerUserId: owner.id, cents: 500, idempotencyKey: tag });
  return {
    keyId: key.id,
    privateJwk: keys.privateJwk as Ed25519PrivateJwk,
    client: new PrepaidPayPalClient({ keyId: key.id, privateJwk: keys.privateJwk }),
  } satisfies TestAgent;
}

/** A GET signed the way the SDK and the MCP server sign it. */
async function signedGet(
  agent: Pick<TestAgent, "privateJwk">,
  url: string,
  options: { now?: () => number; signFor?: string } = {},
): Promise<Request> {
  const signer = createRequestSigner({
    privateJwk: agent.privateJwk,
    signatureAgent: BOTFARE_URL,
    ...(options.now ? { now: options.now } : {}),
  });
  const headers = await signer.sign({ url: options.signFor ?? url });
  return new Request(url, { headers: { ...headers, "x-botfare-agent": "1" } });
}

let agent: TestAgent;
let receiptId: string;

beforeAll(async () => {
  useTestDatabase();
  process.env.BOTFARE_URL = BOTFARE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  resetFacilitator();
  agent = await makeSigningAgent("agent-api", { daily: 200, perRequest: 25 });

  // One settled payment so the key has a receipt and spend today.
  const publisher = await makePublisher(getDb());
  const requirements = requirementsFor(publisher.site.id, 3);
  const body = facilitatorBody(await signPayment(agent.client, requirements), requirements);
  const settled = await (
    await settle(postJson(`${BOTFARE_URL}/api/x402/settle`, body, publisher.auth))
  ).json();
  expect(settled.success).toBe(true);
  receiptId = settled.transaction;
});

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetFacilitator();
  await closeDb();
});

describe("agent API: GET /api/agent/wallet", () => {
  it("returns the key's budget for a valid signature", async () => {
    const response = await walletRoute(await signedGet(agent, `${BOTFARE_URL}/api/agent/wallet`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      keyId: agent.keyId,
      keyName: "agent-api agent",
      balanceUsd: 4.97,
      spentTodayUsd: 0.03,
      dailyCapUsd: 2,
      perRequestMaxUsd: 0.25,
      allowedSiteIds: null,
    });
  });

  it("answers 401 with a clear message when the request is unsigned", async () => {
    const response = await walletRoute(new Request(`${BOTFARE_URL}/api/agent/wallet`));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
    expect(body.message).toMatch(/Sign this request with your BotFare agent key/);
  });

  it("refuses a key BotFare does not know", async () => {
    const stranger = await generateAgentKeyPair();
    const response = await walletRoute(
      await signedGet(
        { privateJwk: stranger.privateJwk as Ed25519PrivateJwk },
        `${BOTFARE_URL}/api/agent/wallet`,
      ),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/not an active BotFare agent key/);
  });

  it("refuses an expired signature", async () => {
    const twoMinutesAgo = Math.floor(Date.now() / 1000) - 120;
    const response = await walletRoute(
      await signedGet(agent, `${BOTFARE_URL}/api/agent/wallet`, { now: () => twoMinutesAgo }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/expired/);
  });

  it("refuses a signature made for another host (e.g. a publisher's)", async () => {
    const request = await signedGet(agent, `${BOTFARE_URL}/api/agent/wallet`, {
      signFor: "https://crema.example/articles/one",
    });
    const response = await walletRoute(request);
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/does not verify/);
  });

  it("accepts each signature once", async () => {
    const request = await signedGet(agent, `${BOTFARE_URL}/api/agent/wallet`);
    const replay = request.clone();
    expect((await walletRoute(request)).status).toBe(200);
    const response = await walletRoute(replay);
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/already used/);
  });

  it("refuses a revoked key", async () => {
    const revoked = await makeSigningAgent("revoked", {});
    await revokeAgentKey(getDb(), { keyId: revoked.keyId });
    const response = await walletRoute(await signedGet(revoked, `${BOTFARE_URL}/api/agent/wallet`));
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/revoked/);
  });
});

describe("agent API: GET /api/agent/receipts", () => {
  it("lists the key's receipts, newest first", async () => {
    const response = await receiptsRoute(
      await signedGet(agent, `${BOTFARE_URL}/api/agent/receipts?limit=5`),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keyId).toBe(agent.keyId);
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      receiptId,
      site: "Crema Notes (test)",
      url: "https://crema.example/articles/grinders",
      amountUsd: 0.03,
      status: "settled",
    });
    expect(Date.parse(body.receipts[0].time)).not.toBeNaN();
  });

  it("validates limit and requires a signature", async () => {
    const bad = await receiptsRoute(
      await signedGet(agent, `${BOTFARE_URL}/api/agent/receipts?limit=0`),
    );
    expect(bad.status).toBe(400);
    const unsigned = await receiptsRoute(new Request(`${BOTFARE_URL}/api/agent/receipts`));
    expect(unsigned.status).toBe(401);
  });

  it("never shows another key's receipts", async () => {
    const other = await makeSigningAgent("other", {});
    const response = await receiptsRoute(
      await signedGet(other, `${BOTFARE_URL}/api/agent/receipts`),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).receipts).toEqual([]);
  });
});
