import { type DemoPersona, isDemoPersonaEmail } from "@botfare/contracts";
import { resetDemoPublisher, type User } from "@botfare/core";
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
 * Restores the persona's demo state before a judge lands on it: Crema Notes' prices, the payout
 * email (PUBLISHER_PAYPAL_EMAIL) and enough earnings to try "Withdraw now". Never blocks sign-in.
 */
export async function prepareDemoPersona(persona: DemoPersona, user: User): Promise<void> {
  if (persona !== "publisher") return;
  try {
    await resetDemoPublisher(getDb(), {
      userId: user.id,
      payoutEmail: process.env.PUBLISHER_PAYPAL_EMAIL?.trim() || null,
    });
  } catch (err) {
    console.error("judge mode: could not reset the publisher persona", err);
  }
}
