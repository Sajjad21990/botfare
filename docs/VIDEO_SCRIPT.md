# BotFare demo video script

**Target:** 2:50, public on YouTube. The money lands in a PayPal sandbox account before 2:30. The video closes on "Pay the fare, pal."

**Rules:**
- Only fictional names (Crema Notes).
- No third-party logos, apart from PayPal's own sandbox pages showing the payment.
- No copyrighted music. An AI voiceover is fine.
- Say "AI agent" in the voiceover ("bot" only in the tagline). Say "AI", not a model name: the live site runs Groq's `openai/gpt-oss-120b`.

## Before recording

1. Use the deployed app (https://botfare-web.onrender.com), or run the stack locally: `pnpm dev:web` plus `pnpm dev:demo`, or the judge Docker stack on :3300.
2. Use a fresh browser profile at 1440×900 with 125% zoom so text is readable. Turn notifications off.
3. Run one research run before recording, so models and caches are warm. On the live site the agent runs on Groq's free tier, where a run takes 1–2 minutes because of rate-limit waits. Record it at normal speed and speed up the waiting parts 4× in the edit.
4. Keep these open in tabs:
   - the landing page `/`, scrolled to the top
   - `/judge`
   - the demo article https://botfare-demo.onrender.com/articles/burr-basics
   - a terminal with the first command from `/judge` → **For developers**
   - the PayPal sandbox publisher account (sandbox.paypal.com, signed in by you)
5. The top-up needs the sandbox buyer from `/judge` → **PayPal test account**. Copy the email and password with its copy buttons before recording, and keep the password hidden on camera: don't click **Show** while recording.
6. Already recorded as B-roll: the top-up approval and the Payouts batch landing. Use them if the sandbox is slow on the day.
7. Links to other sites and side trips open in a new tab: on the landing **See the code**, **README** and **Verify a signed receipt**; on `/judge` the step buttons and **Charts**. `/judge` stays open as the tour, so switch back to its tab between scenes and close the extra tabs before the next take. **Try it in 2 minutes** stays in the same tab.

## Scenes

| Time | Scene | Exact clicks | Voiceover |
| --- | --- | --- | --- |
| 0:00–0:15 | The problem | The landing page (`/`): the hero, "Every bot pays its **fare**.", with the 3¢ receipt ticket (**Paid by** Research agent, **Paid to** Crema Notes, stamped **PAID**) | "AI agents read websites for free, and the clicks that paid for the writing are going away: with an AI summary on the page, people click a result on 8% of visits instead of 15%." |
| 0:15–0:30 | The idea | Scroll past the **Fare Court** and **Fare Advisor** cards right under the hero (they come back at 1:50) and **How it works** (three ticket stubs) to the yellow band, **Your site adds one line of code**. Hold on the one line under **Your website**, then click **Your AI agent** | "BotFare lets a website charge AI agents a few cents a page, paid through PayPal. The site adds one line of code, the agent a few more, and people still read free." |
| 0:30–0:42 | Built on PayPal | Scroll to **1 fee, not 166.** and hold on the fee dots. Then click **Try it in 2 minutes** in the header | "A PayPal payment for a 3-cent page would cost about 49 cents in fees. One $5 top-up covers about 166 pages: one fee, not 166." |
| 0:42–0:50 | A person vs an AI agent | Browser tab: the Crema Notes article loads free. Terminal: run the first command from **For developers**, which returns `402 Payment Required` with `PAYMENT-REQUIRED` | "A browser reads free. An AI agent gets a price and a free preview." |
| 0:50–1:35 | Step 1: an AI agent pays | `/judge` → step 1 **Watch an AI agent pay** → **Run the agent**. Keep the suggested question and the default model, press **Run**. Show the timeline: offers read for free, **Paid 3¢ to Crema Notes**, a **Skipped** page with its reason, the 50¢ page refused (**Purchase refused**) and, if the agent bought the grinder stub, its dispute marked **Refunded**. Click a **Paid 3¢ to Crema Notes** entry to show it in the **Wire inspector**: the decoded `PAYMENT-REQUIRED` → signed `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE`. End on the answer with citations and open **Verify sources** (Paid ✓ Delivered ✓ Bytes match ✓) | "The agent reads each offer free, decides what's worth paying for, and pays 3 cents over x402. The 50-cent page? A cap in code refuses it, not the prompt. Every citation is a paid, signed receipt anyone can verify." |
| 1:35–1:50 | Step 2: the website's side | `/judge` → step 2 **See the website's side** → **Open the dashboard**. The earnings at the top (what agents paid), then the Crema Notes card: the **Turned on with one line** callout and the **Pricing** tab (3¢ articles, 50¢ premium, 1¢ brew API) | "This is Crema Notes, our demo coffee site. It turned BotFare on with one line and sets its prices here, not in its code." |
| 1:50–2:08 | Fare Court and Fare Advisor | Nav **Disputes**: a refunded stub dispute with the AI's reasoning. Nav **Dashboard**: the **Fare Advisor** card's top recommendation ("Thin listicle, not worth 50¢") and **Apply** | "Paid for a stub instead of the article? Fare Court compares what was promised with the bytes delivered and refunds 3 cents in seconds. Fare Advisor turns why agents didn't buy into a price change the site applies with one click." |
| 2:08–2:28 | Money lands | Nav **Analytics** (the **Charts** link on `/judge`): the AG Studio revenue and citations widgets. Back on **Dashboard**: the earnings ready to withdraw and the amount on hold for the 24 h dispute window, then **Withdraw** → **Payout history** shows the PayPal batch → the sandbox publisher account shows the payment | "Earnings clear after the dispute window, and one click sends them to the site's PayPal account through PayPal Payouts." |
| 2:28–2:40 | Step 3: fund an agent with PayPal | `/judge` → step 3 **Fund an agent with PayPal** → **Open the wallet**. **Top up** $5 with the PayPal button: the sandbox pop-up, log in with the copied **PayPal test account**, approve, and the balance goes up (cut to the B-roll if the sandbox is slow). Then **Agent keys**: the daily limit and the per-page maximum | "And the agent's money? Its owner topped up once with PayPal and gave the agent a key with a daily limit." |
| 2:40–2:50 | Close | The landing hero again, then the tagline card | "BotFare: x402 for PayPal's 440 million accounts. Every bot pays its fare. Pay the fare, pal." |

## After recording

- Upload to YouTube as **Public**. Description:
  - one line, "BotFare: pay-per-request for AI agents, settled on PayPal (PayPal AI Hackathon 2026)";
  - the repo link;
  - the live app link.
- Paste the YouTube link into Devpost.
- Take screenshots from the same session for Devpost:
  - the landing hero, the **Fare Court** and **Fare Advisor** cards under it, and the **Set up** band;
  - the publisher dashboard with the one-line callout;
  - wallet top-up;
  - the agent's answer with the wire inspector;
  - AG Studio analytics;
  - the Payouts batch;
  - `/verify`.
