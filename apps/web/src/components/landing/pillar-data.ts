/** The three parts of BotFare, in the order the page tells them. Shared by the nav and the index. */
export const pillars = [
  {
    id: "fares",
    name: "Fares",
    question: "How does a bot pay 3¢ through PayPal?",
    summary: "x402 pay-per-request, funded by PayPal, paid out in batches.",
  },
  {
    id: "fare-court",
    name: "Fare Court",
    question: "Was that 3¢ page what was promised?",
    summary: "Buyer protection for purchases too small for a person to dispute.",
  },
  {
    id: "fare-advisor",
    name: "Fare Advisor",
    question: "Why didn’t the bot buy?",
    summary: "Prices from what agents say and do, with one click to apply.",
  },
] as const;

export type PillarId = (typeof pillars)[number]["id"];
