import type { ChargeRequest } from "@botfare/x402-paypal";
import { generateAgentKeyPair, PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { expect } from "vitest";
import {
  type CreateAgentKeyInput,
  checkLedgerInvariants,
  createAgentKey,
  createDb,
  createSite,
  createUser,
  type Db,
  seedWallet,
} from "../src";
import { testDatabaseUrl } from "./db-url";

/** A pool large enough for the concurrency tests to really run in parallel. */
export function openTestDb() {
  return createDb(testDatabaseUrl(), { max: 25 });
}

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeUser(db: Db, label = "user") {
  const tag = unique(label);
  return createUser(db, { email: `${tag}@example.test`, name: tag });
}

/** A publisher user with one site charging 3¢ for /articles/*. */
export async function makePublisher(db: Db) {
  const owner = await makeUser(db, "publisher");
  const { site, siteSecret } = await createSite(db, {
    ownerUserId: owner.id,
    name: "Brewlab Demo",
    origin: "https://brewlab.example",
    pricing: [{ pattern: "/articles/*", priceCents: 3 }],
  });
  return { owner, site, siteSecret };
}

/** An agent owner with a funded wallet and one key. */
export async function makeAgent(
  db: Db,
  options: { balanceCents?: number } & Partial<Omit<CreateAgentKeyInput, "ownerUserId">> = {},
) {
  const owner = await makeUser(db, "agent-owner");
  const keys = await generateAgentKeyPair();
  const key = await createAgentKey(db, {
    name: "research agent",
    publicJwk: keys.publicJwk,
    ...options,
    ownerUserId: owner.id,
  });
  if (options.balanceCents) {
    await seedWallet(db, {
      ownerUserId: owner.id,
      cents: options.balanceCents,
      idempotencyKey: `test:${owner.id}`,
    });
  }
  return { owner, key, keys };
}

export function chargeRequest(
  keyId: string,
  payTo: string,
  overrides: Partial<ChargeRequest> = {},
): ChargeRequest {
  return {
    keyId,
    payTo,
    nonce: crypto.randomUUID(),
    amountCents: 3,
    network: PAYPAL_SANDBOX,
    resourceUrl: "https://brewlab.example/articles/grinders",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

/** Zero-sum overall and per transaction, and every cached balance equals its entries. */
export async function expectLedgerHealthy(db: Db) {
  const report = await checkLedgerInvariants(db);
  expect(report).toEqual({
    ok: true,
    totalMicros: 0,
    balanceMismatches: [],
    unbalancedTransactions: [],
  });
}
