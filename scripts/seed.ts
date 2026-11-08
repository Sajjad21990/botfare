/**
 * `pnpm seed`: prepares the local database for the demo. Safe to run again.
 *
 * - applies migrations;
 * - creates (or reuses, by email) the Crema Notes publisher and an agent owner;
 * - registers the Crema Notes site with apps/demo's pricing and free paths, and rotates its secret;
 * - gives the agent owner a one-time $5.00 demo balance;
 * - issues a demo agent key (10¢ per request, $1.00 a day), reusing the one in .env if it matches;
 * - writes BOTFARE_URL, BOTFARE_SITE_ID, BOTFARE_SITE_SECRET and BOTFARE_AGENT_KEY to .env.
 *
 * Secrets are never printed: only IDs and the last four characters.
 */
import { agentKeyPayloadSchema, decodeAgentKey, encodeAgentKey } from "@botfare/contracts";
import {
  type AgentKey,
  createAgentKey,
  createDb,
  createSite,
  createUser,
  type Db,
  getAgentKeyById,
  getUserByEmail,
  listSites,
  migrate,
  revokeAgentKey,
  rotateSiteSecret,
  seedWallet,
  type User,
  updateSitePricing,
  updateSiteProfile,
  walletBalanceMicros,
} from "@botfare/core";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { freePaths, pricing, SITE_NAME } from "../apps/demo/src/pricing";
import { lastFour, loadRootEnv, requireEnv, updateEnvFile } from "./lib/env-file";

const PUBLISHER = { email: "publisher@crema-notes.example", name: "Crema Notes publisher" };
const AGENT_OWNER = { email: "agent-owner@botfare.example", name: "Demo agent owner" };
const DEMO_ORIGIN = "http://localhost:4000";
const DEFAULT_BOTFARE_URL = "http://localhost:3000";
const WALLET_CENTS = 500;
const AGENT_KEY = { name: "Demo research agent", perRequestMaxCents: 10, dailyCapCents: 100 };

async function findOrCreateUser(db: Db, input: { email: string; name: string }): Promise<User> {
  return (await getUserByEmail(db, input.email)) ?? createUser(db, input);
}

/** The key in .env, if it is this owner's active key with the demo limits and its public key matches. */
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
  const matches =
    key.publicJwk.x === payload.privateJwk.x &&
    key.perRequestMaxCents === AGENT_KEY.perRequestMaxCents &&
    key.dailyCapCents === AGENT_KEY.dailyCapCents &&
    key.allowedSiteIds === null;
  if (!matches) {
    await revokeAgentKey(db, { keyId: key.id, ownerUserId: owner.id });
    return null;
  }
  return key;
}

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = requireEnv("DATABASE_URL");
  const botfareUrl = process.env.BOTFARE_URL?.trim() || DEFAULT_BOTFARE_URL;
  const payoutEmail = process.env.PUBLISHER_PAYPAL_EMAIL?.trim() || null;

  await migrate(databaseUrl);
  console.log("Migrations applied");

  const { db, close } = createDb(databaseUrl, { max: 2 });
  try {
    const publisher = await findOrCreateUser(db, PUBLISHER);
    const agentOwner = await findOrCreateUser(db, AGENT_OWNER);
    console.log(`Publisher    ${publisher.id} (${publisher.email})`);
    console.log(`Agent owner  ${agentOwner.id} (${agentOwner.email})`);

    // Site: same rules and free paths as apps/demo/src/pricing.ts, fresh secret every run.
    const existingSite = (await listSites(db, publisher.id)).find((s) => s.name === SITE_NAME);
    let siteId: string;
    let siteSecret: string;
    if (existingSite) {
      await updateSitePricing(db, { siteId: existingSite.id, pricing, freePaths });
      await updateSiteProfile(db, { siteId: existingSite.id, origin: DEMO_ORIGIN, payoutEmail });
      const rotated = await rotateSiteSecret(db, { siteId: existingSite.id });
      if (!rotated) throw new Error(`Site ${existingSite.id} vanished`);
      siteId = rotated.site.id;
      siteSecret = rotated.siteSecret;
      console.log(`Site         ${siteId} updated, secret rotated (${lastFour(siteSecret)})`);
    } else {
      const created = await createSite(db, {
        ownerUserId: publisher.id,
        name: SITE_NAME,
        origin: DEMO_ORIGIN,
        pricing,
        freePaths,
        payoutEmail,
      });
      siteId = created.site.id;
      siteSecret = created.siteSecret;
      console.log(`Site         ${siteId} created (${lastFour(siteSecret)})`);
    }
    console.log(`             ${pricing.length} pricing rules, ${freePaths.length} free paths`);
    console.log(`             payout email ${payoutEmail ? "set" : "not set"}`);

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
    console.log("             10¢ per request max, $1.00 daily cap, any site");

    updateEnvFile({
      BOTFARE_URL: botfareUrl,
      BOTFARE_SITE_ID: siteId,
      BOTFARE_SITE_SECRET: siteSecret,
      BOTFARE_AGENT_KEY: agentKey,
    });
    console.log(
      "\nWrote BOTFARE_URL, BOTFARE_SITE_ID, BOTFARE_SITE_SECRET and BOTFARE_AGENT_KEY to .env",
    );
    console.log("Restart the demo (pnpm dev:demo) so it picks up the new site secret.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("FAIL seed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
