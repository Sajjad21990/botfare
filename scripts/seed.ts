/**
 * `pnpm seed`: prepares a database for the demo. Safe to run again.
 *
 * - applies migrations;
 * - creates (or reuses, by email) the two judge personas from DEMO_PERSONAS: the Crema Notes
 *   publisher and the agent owner;
 * - sets the publisher's payout email (and the site's) to PUBLISHER_PAYPAL_EMAIL, the sandbox
 *   personal account that receives test Payouts;
 * - registers the Crema Notes site with apps/demo's pricing and free paths at DEMO_ORIGIN
 *   (default http://localhost:4000), keeping the site secret in the environment while it still
 *   works and issuing a new one otherwise;
 * - gives the agent owner a one-time $5.00 demo balance (in judge mode the app keeps it at $5.00:
 *   lib/server/judge.ts);
 * - issues the demo agent key (10¢ per request, $10.00 a day: every judge's research run shares
 *   it), reusing the one in .env if it is this owner's, and raising its limits in place if they
 *   changed;
 * - writes BOTFARE_URL, BOTFARE_SITE_ID, BOTFARE_SITE_SECRET and BOTFARE_AGENT_KEY to .env.
 *
 * Flags:
 *   --rotate-site-secret  issue a new site secret even if the current one works
 *   --print-secrets       also print the full site secret and agent key, for copying into
 *                         botfare-demo's Render environment (README "Deploy")
 *
 * Without --print-secrets, secrets are never printed: only IDs and the last four characters.
 *
 * BOTFARE_JUDGE_DOCKER=1 (set by docker-compose.full.yml's setup service) drops the "restart the
 * demo" hint: in the judge Docker stack the demo starts after the seed and reads the new secret.
 */

import { parseArgs } from "node:util";
import {
  agentKeyPayloadSchema,
  DEMO_PERSONAS,
  decodeAgentKey,
  encodeAgentKey,
} from "@botfare/contracts";
import {
  type AgentKey,
  createAgentKey,
  createDb,
  createUser,
  type Db,
  getAgentKeyById,
  getUserByEmail,
  migrate,
  revokeAgentKey,
  seedWallet,
  setPayoutEmail,
  type User,
  updateAgentKeyLimits,
  walletBalanceMicros,
} from "@botfare/core";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { freePaths, pricing } from "../apps/demo/src/pricing";
import { demoSiteOrigin, ensureDemoSite } from "./lib/demo-site";
import { lastFour, loadRootEnv, requireEnv, updateEnvFile } from "./lib/env-file";

const PUBLISHER = DEMO_PERSONAS.publisher;
const AGENT_OWNER = DEMO_PERSONAS.agentOwner;
const DEFAULT_BOTFARE_URL = "http://localhost:3000";
const WALLET_CENTS = 500;
const AGENT_KEY = { name: "Demo research agent", perRequestMaxCents: 10, dailyCapCents: 1_000 };

async function findOrCreateUser(db: Db, input: { email: string; name: string }): Promise<User> {
  return (
    (await getUserByEmail(db, input.email)) ??
    createUser(db, { email: input.email, name: input.name })
  );
}

/**
 * The key in .env, if it is this owner's active key and its public key matches; its limits are
 * set to the demo's in place (so the secret survives a cap change). A key that is not this
 * owner's, or whose public key differs, is revoked and null is returned.
 */
async function reusableAgentKey(db: Db, owner: User): Promise<AgentKey | null> {
  const existing = process.env.BOTFARE_AGENT_KEY?.trim();
  if (!existing) return null;
  let payload: ReturnType<typeof decodeAgentKey>;
  try {
    payload = decodeAgentKey(existing);
  } catch {
    return null;
  }
  const key = await getAgentKeyById(db, payload.keyId);
  if (!key || key.ownerUserId !== owner.id || key.status !== "active") return null;
  if (key.publicJwk.x !== payload.privateJwk.x) {
    await revokeAgentKey(db, { keyId: key.id, ownerUserId: owner.id });
    return null;
  }
  const limitsMatch =
    key.perRequestMaxCents === AGENT_KEY.perRequestMaxCents &&
    key.dailyCapCents === AGENT_KEY.dailyCapCents &&
    key.allowedSiteIds === null;
  if (limitsMatch) return key;
  return updateAgentKeyLimits(db, {
    keyId: key.id,
    perRequestMaxCents: AGENT_KEY.perRequestMaxCents,
    dailyCapCents: AGENT_KEY.dailyCapCents,
    allowedSiteIds: null,
  });
}

async function main(): Promise<void> {
  const { values: flags } = parseArgs({
    options: {
      "rotate-site-secret": { type: "boolean", default: false },
      "print-secrets": { type: "boolean", default: false },
    },
  });
  loadRootEnv();
  const databaseUrl = requireEnv("DATABASE_URL");
  const botfareUrl = process.env.BOTFARE_URL?.trim() || DEFAULT_BOTFARE_URL;
  const payoutEmail = process.env.PUBLISHER_PAYPAL_EMAIL?.trim() || null;
  const origin = demoSiteOrigin();

  await migrate(databaseUrl);
  console.log("Migrations applied");

  const { db, close } = createDb(databaseUrl, { max: 2 });
  try {
    const publisher = await findOrCreateUser(db, PUBLISHER);
    const agentOwner = await findOrCreateUser(db, AGENT_OWNER);
    // The payout email lives on the publisher's profile; leave it alone when the env has none.
    if (payoutEmail) await setPayoutEmail(db, { userId: publisher.id, email: payoutEmail });
    console.log(`Publisher    ${publisher.id} (${publisher.email})`);
    console.log(`Agent owner  ${agentOwner.id} (${agentOwner.email})`);

    // Site: same rules and free paths as apps/demo/src/pricing.ts; the secret survives reruns.
    const { siteId, siteSecret, action } = await ensureDemoSite(db, {
      publisherId: publisher.id,
      origin,
      payoutEmail,
      current: {
        siteId: process.env.BOTFARE_SITE_ID?.trim(),
        siteSecret: process.env.BOTFARE_SITE_SECRET?.trim(),
      },
      rotate: flags["rotate-site-secret"],
    });
    const what = {
      created: "created",
      kept: "updated, secret kept",
      rotated: "updated, new secret",
    };
    console.log(`Site         ${siteId} ${what[action]} (${lastFour(siteSecret)}) at ${origin}`);
    console.log(`             ${pricing.length} pricing rules, ${freePaths.length} free paths`);
    console.log(
      `             payout email ${payoutEmail ? "set on the publisher and the site" : "not set (PUBLISHER_PAYPAL_EMAIL is empty)"}`,
    );

    // Wallet: a one-time demo balance (idempotent by key, so reruns add nothing).
    const seeded = await seedWallet(db, {
      ownerUserId: agentOwner.id,
      cents: WALLET_CENTS,
      idempotencyKey: `demo-wallet:${agentOwner.id}`,
      memo: "Demo balance for the local agent",
    });
    const balance = await walletBalanceMicros(db, agentOwner.id);
    console.log(
      `Wallet       ${seeded.created ? "seeded $5.00" : "already seeded"}; balance $${(balance / 1_000_000).toFixed(4)}`,
    );

    // Agent key: reuse the one in .env when it still matches, else issue a new one.
    let agentKey = process.env.BOTFARE_AGENT_KEY?.trim() ?? "";
    const reused = await reusableAgentKey(db, agentOwner);
    if (reused) {
      console.log(`Agent key    ${reused.id} reused (${lastFour(agentKey)})`);
    } else {
      const { publicJwk, privateJwk } = await generateAgentKeyPair();
      const key = await createAgentKey(db, {
        ownerUserId: agentOwner.id,
        publicJwk,
        ...AGENT_KEY,
      });
      agentKey = encodeAgentKey(agentKeyPayloadSchema.parse({ v: 1, keyId: key.id, privateJwk }));
      console.log(`Agent key    ${key.id} issued (${lastFour(agentKey)})`);
    }
    console.log("             10¢ per request max, $10.00 daily cap, any site");

    updateEnvFile({
      BOTFARE_URL: botfareUrl,
      BOTFARE_SITE_ID: siteId,
      BOTFARE_SITE_SECRET: siteSecret,
      BOTFARE_AGENT_KEY: agentKey,
    });
    console.log(
      "\nWrote BOTFARE_URL, BOTFARE_SITE_ID, BOTFARE_SITE_SECRET and BOTFARE_AGENT_KEY to .env",
    );
    // In the judge Docker stack the demo container starts after this and loads the new secret.
    if (action !== "kept" && process.env.BOTFARE_JUDGE_DOCKER !== "1") {
      console.log("Restart the demo (pnpm dev:demo) so it picks up the new site secret.");
    }
    if (flags["print-secrets"]) {
      console.log("\nFor botfare-demo's environment on Render (Environment > Edit):");
      console.log(`BOTFARE_SITE_ID=${siteId}`);
      console.log(`BOTFARE_SITE_SECRET=${siteSecret}`);
      console.log("For the agent's .env on your machine:");
      console.log(`BOTFARE_AGENT_KEY=${agentKey}`);
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("FAIL seed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
