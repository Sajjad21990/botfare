/**
 * The AI's words, as Fare Advisor shows them. Revenue is BotFare's to estimate (the "BotFare
 * estimate" badge, from the rule's own funnel), so a sentence where the model claims revenue
 * ("raising to 2¢ can double revenue") is left out: it could contradict the estimate beside it.
 */

const REVENUE_CLAIM =
  /\b(revenues?|earnings|income|profits?|money|earn|earns|earned|earning|make more|makes more)\b/i;

/** True when the sentence makes a claim about money coming in. */
export function isRevenueClaim(sentence: string): boolean {
  return REVENUE_CLAIM.test(sentence);
}

/** `text` without its revenue sentences; "" when every sentence was one. */
export function withoutRevenueClaims(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim() !== "" && !isRevenueClaim(sentence))
    .join(" ")
    .trim();
}
