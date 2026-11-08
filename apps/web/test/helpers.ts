import { siteAuthHeader } from "@botfare/contracts";
import { createAgentKey, createSite, createUser, type Db, seedWallet } from "@botfare/core";
import {
  generateAgentKeyPair,
  PAYPAL_SANDBOX,
  PREPAID_SCHEME,
  PrepaidPayPalClient,
} from "@botfare/x402-paypal";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** Points the app's DATABASE_URL at the test database; call before the first request. */
export function useTestDatabase(): void {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://botfare:botfare@localhost:5432/botfare_test";
}

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A publisher with one site charging 3¢ for /articles/*. */
export async function makePublisher(db: Db) {
  const tag = unique("web-publisher");
  const owner = await createUser(db, { email: `${tag}@example.test`, name: tag });
  const { site, siteSecret } = await createSite(db, {
    ownerUserId: owner.id,
    name: "Crema Notes (test)",
    origin: "https://crema.example",
    pricing: [{ pattern: "/articles/*", priceCents: 3 }],
  });
  return { owner, site, siteSecret, auth: siteAuthHeader(site.id, siteSecret) };
}

/** An agent owner with a funded wallet, one key, and a client that signs payments with it. */
export async function makeAgent(db: Db, balanceCents: number) {
  const tag = unique("web-agent");
  const owner = await createUser(db, { email: `${tag}@example.test`, name: tag });
  const keys = await generateAgentKeyPair();
  const key = await createAgentKey(db, {
    ownerUserId: owner.id,
    name: "research agent",
    publicJwk: keys.publicJwk,
  });
  await seedWallet(db, { ownerUserId: owner.id, cents: balanceCents, idempotencyKey: tag });
  const client = new PrepaidPayPalClient({ keyId: key.id, privateJwk: keys.privateJwk });
  return { owner, key, client };
}

export function requirementsFor(payTo: string, amountCents = 3): PaymentRequirements {
  return {
    scheme: PREPAID_SCHEME,
    network: PAYPAL_SANDBOX,
    asset: "USD",
    amount: String(amountCents),
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

/** A signed x402 V2 payment for `requirements`, as @x402/fetch would send it. */
export async function signPayment(
  client: PrepaidPayPalClient,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> {
  const created = await client.createPaymentPayload(2, requirements);
  return {
    x402Version: 2,
    resource: { url: "https://crema.example/articles/grinders" },
    accepted: requirements,
    payload: created.payload,
  };
}

/** A JSON POST as the SDK's HTTPFacilitatorClient (or a publisher) sends it. */
export function postJson(url: string, body: unknown, auth?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function facilitatorBody(payload: PaymentPayload, requirements: PaymentRequirements) {
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
}
