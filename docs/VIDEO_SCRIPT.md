# BotFare demo video script

**Target:** 2:50, public on YouTube. The money lands in a PayPal sandbox account before 2:30. The video closes on "Pay the fare, pal."

**Rules:**
- Only fictional names (Crema Notes).
- No third-party logos, apart from PayPal's own sandbox pages showing the payment.
- No copyrighted music. An AI voiceover is fine.

## Before recording

1. Use the deployed app (`<BOTFARE_URL>`), or run the stack locally: `pnpm dev:web` plus `pnpm dev:demo`, or the judge Docker stack on :3300.
2. Use a fresh browser profile at 1440×900 with 125% zoom so text is readable. Turn notifications off.
3. Run one research run before recording, so models and caches are warm. On Groq's free tier a run takes 1–2 minutes because of rate-limit waits. Record it at normal speed and speed up the waiting parts 4× in the edit; Claude runs finish in under a minute.
4. Keep these open in tabs:
   - `/judge`
   - the demo article `<DEMO_PUBLIC_URL>/articles/burr-basics`
   - a terminal with the curl from `/judge`
   - the PayPal sandbox publisher account (sandbox.paypal.com, signed in by you)
5. Already recorded as B-roll: the top-up approval and the Payouts batch landing. Use them if the sandbox is slow on the day.

## Scenes

| Time | Scene | Exact clicks | Voiceover |
| --- | --- | --- | --- |
| 0:00–0:20 | The problem | The landing page (`/`): scroll from the hero to the fee table | "AI agents read the web for free, and the writers lose the clicks that paid them. x402 lets agents pay per request, but only in crypto. A PayPal payment for a 3-cent article costs about 49 cents in fees." |
| 0:20–0:30 | The idea | Landing hero: "Every bot pays its fare." | "BotFare is x402 for PayPal's 440 million accounts." |
| 0:30–0:55 | Publisher | `/judge` → **Be the publisher** → **Open the publisher**. On the Crema Notes site card, show the pricing rules (3¢ articles, 50¢ premium) and the **Add one line to your Express app** snippet | "A publisher adds one line of middleware and sets prices here. People read free; agents pay." |
| 0:55–1:05 | A person vs an agent | Browser tab: the article loads free. Terminal: run the curl from **See a 402 yourself**, which returns `402` with `PAYMENT-REQUIRED` | "A browser reads free. A bot gets a price." |
| 1:05–1:20 | Agent owner | `/judge` → **Be the agent owner** → **Open the wallet**. Show the balance, then **Top up $5 with the PayPal button**: the PayPal sandbox pop-up, approve with the sandbox buyer, the balance goes up. Then show **Agent keys** with the daily cap and per-request max | "Agent owners top up once with PayPal, one fee for about 166 reads, and give each agent a budget." |
| 1:20–2:00 | Agent at work | `/judge` → **Run the research agent**. Keep the suggested question and the default model, press **Run the agent**. Show the timeline: offers read for free, **Bought** 3¢ pages, a skip with its reason, the 50¢ page refused (**Purchase refused**). Click **Show this payment in the wire inspector** for the decoded `PAYMENT-REQUIRED` → signed `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE`. End on the answer with citations, open **Verify sources** (Paid ✓ Delivered ✓ Bytes match ✓) | "The agent reads each offer free, decides what's worth paying for, and pays 3 cents over x402. The 50-cent page? Its cap refuses it in code, not in the prompt. Every citation is a paid, signed receipt anyone can verify." |
| 2:00–2:15 | Fare Court and Fare Advisor | `/publisher/disputes`: a refunded stub dispute with the AI's reasoning. Then `/publisher`: the **Fare Advisor** card's recommendation ("Thin listicle, not worth 50¢") and **Apply** | "Bought a stub instead of the article? Fare Court compares the promise with the attested bytes and refunds 3 cents in seconds. Fare Advisor turns why bots didn't buy into a price change." |
| 2:15–2:35 | Money lands | `/publisher/analytics`: the AG Studio revenue and citations widgets. Back on `/publisher`: **Earnings**, Available and Clearing, then **Withdraw now** → payout history shows the PayPal batch → the sandbox publisher account shows the payment | "Earnings clear after the dispute window, and Withdraw now sends them to the publisher's PayPal through Payouts." |
| 2:35–2:50 | Close | The architecture diagram from the README, then the tagline card | "BotFare: x402 for PayPal's 440 million accounts. Every bot pays its fare. Pay the fare, pal." |

## After recording

- Upload to YouTube as **Public**. Description:
  - one line, "BotFare: pay-per-request for AI agents, settled on PayPal (PayPal AI Hackathon 2026)";
  - the repo link;
  - the live app link.
- Paste the YouTube link into Devpost.
- Take screenshots from the same session for Devpost:
  - publisher setup;
  - wallet top-up;
  - the agent's answer with the wire inspector;
  - AG Studio analytics;
  - the Payouts batch;
  - `/verify`.
