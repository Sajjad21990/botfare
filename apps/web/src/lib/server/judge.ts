import { type DemoPersona, decodeAgentKey, isDemoPersonaEmail } from "@botfare/contracts";
import {
  type AgentKey,
  type DisputeKeyLimits,
  ensureDemoWalletFloor,
  getAgentKeyById,
  getUserById,
  resetDemoPublisher,
  type User,
} from "@botfare/core";
import { getDb } from "./db";
import { jsonError } from "./http";

/**
 * Judge mode. Every judge shares the two persona users, so actions that would break the demo for
 * the next judge are refused for them (rotating the demo site's secret, changing the payout email,
 * revoking the seeded agent keys), and the publisher persona's demo state is restored at sign-in.
 */
export function isJudge(user: Pick<User, "email">): boolean {
  return isDemoPersonaEmail(user.email);
}

/** 403 for an action the shared demo accounts may not take. */
export function judgeModeRefusal(message: string): Response {
  return jsonError(403, "judge_mode", `${message} This is turned off in judge mode.`);
}

/**
 * Restores the persona's demo state before a judge lands on it. Publisher: Crema Notes' prices,
 * the payout email (PUBLISHER_PAYPAL_EMAIL), enough earnings to try "Withdraw now" and a Fare
 * Court dispute waiting for review. Agent
 * owner: a wallet balance the shared research agent can pay from. Never blocks sign-in.
 */
export async function prepareDemoPersona(persona: DemoPersona, user: User): Promise<void> {
  try {
    if (persona === "publisher") {
      await resetDemoPublisher(getDb(), {
        userId: user.id,
        payoutEmail: process.env.PUBLISHER_PAYPAL_EMAIL?.trim() || null,
      });
    } else if (persona === "agentOwner") {
      await ensureDemoWalletFloor(getDb(), { userId: user.id });
    }
  } catch (err) {
    console.error(`judge mode: could not reset the ${persona} persona`, err);
  }
}

/**
 * Before a research run: when the server's agent key (BOTFARE_AGENT_KEY) belongs to a shared demo
 * persona, tops its wallet back up to the demo floor, so every judge's run can pay even after
 * earlier judges spent the balance. Never throws; a real owner's wallet is never touched.
 */
export async function refillDemoAgentWallet(agentKey: string): Promise<void> {
  try {
    const db = getDb();
    const key = await getAgentKeyById(db, decodeAgentKey(agentKey).keyId);
    if (key?.status !== "active") return;
    const owner = await getUserById(db, key.ownerUserId);
    if (!owner || !isDemoPersonaEmail(owner.email)) return;
    await ensureDemoWalletFloor(db, { userId: owner.id });
  } catch (err) {
    console.error("judge mode: could not top up the demo agent wallet", (err as Error)?.message);
  }
}

/**
 * Fare Court limits for the shared demo research key. Every judge's research run disputes with
 * this one key (BOTFARE_AGENT_KEY, owned by a demo persona), so DISPUTE_POLICY's per-key rules,
 * written for one agent, would stop the demo for everyone after a few runs: ten disputes a day,
 * and the 7-day dispute-rate rule that sends refunds to the publisher once a key disputes more than
 * a fifth of its purchases. For that key only: 200 disputes a day and no rate rule. Refunds still
 * need a confident AI verdict (or the publisher) and still go through the ledger's one refund per
 * receipt. Any other key, including a judge's own, keeps the normal policy (undefined).
 */
export const SHARED_DEMO_KEY_DISPUTE_LIMITS: DisputeKeyLimits = {
  maxDisputesPerDay: 200,
  autoRefundRateRule: false,
};

export async function disputeLimitsFor(
  key: Pick<AgentKey, "id" | "ownerUserId">,
): Promise<DisputeKeyLimits | undefined> {
  const configured = process.env.BOTFARE_AGENT_KEY?.trim();
  if (!configured) return undefined;
  try {
    if (decodeAgentKey(configured).keyId !== key.id) return undefined;
    const owner = await getUserById(getDb(), key.ownerUserId);
    return owner && isDemoPersonaEmail(owner.email) ? SHARED_DEMO_KEY_DISPUTE_LIMITS : undefined;
  } catch {
    return undefined;
  }
}
