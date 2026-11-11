# BotFare: Devpost submission text

Copy each section into the matching Devpost field. The story (Inspiration to What's next) is under 600 words.

**Name:** BotFare
**Tagline:** Every bot pays its fare. x402 for PayPal's 440 million accounts.

---

## Inspiration

AI agents read the web for people, and small publishers lose the clicks that paid for the writing: with a Google AI Overview on the page, people click a result on 8% of visits instead of 15% ([Pew Research Center, 2025](https://www.seroundtable.com/pew-google-ai-overviews-39808.html)). x402, the open standard for paying per request, settles only in stablecoins. PayPal is a Premier member of the x402 Foundation, yet x402 cannot settle to a PayPal account, and a PayPal payment for a 2¢ recipe costs about 49¢ in fees. We wanted an agent to pay 2¢ and the cook who wrote it to receive it in PayPal.

## What it does

BotFare is pay-per-request for AI agents, settled on **PayPal**:

- **Publishers** add one line of middleware (`botfare({ siteId, siteSecret })`), set prices in the dashboard and get paid through **PayPal Payouts**. People read free: a score, never a hard block, decides who pays.
- **Agent owners** top up a USD wallet with **PayPal Checkout** and give each agent a key with a budget (daily cap, per-request max, allowed sites).
- **Agents** get an x402 `402`, sign a payment and receive the page. One $5 top-up (one $0.66 PayPal fee, absorbed by BotFare) covers 250 recipes at 2¢.
- **AI on every side of the fare:** a research agent buys or skips each page, with a reason. **Fare Court** is AI buyer protection for 2¢ purchases: it compares what was promised with the attested bytes and refunds through policy in code. **Fare Advisor** turns agents' decline reasons, citations and disputes into pricing advice the publisher applies with one click.
- **Signed receipts:** BotFare signs payment, delivery and refund statements (Ed25519 JWS) that anyone can verify offline on `/verify`.

## How we built it

- **x402:** a real plug-in for the official `@x402/*` 2.30.0 SDK (scheme `prepaid`, network `paypal:sandbox`) with client, server and facilitator parts, used by `@x402/express`, `@x402/fetch` and `x402Facilitator`. Settlement happens only after the publisher's handler succeeds.
- **PayPal:** Orders v2 with JS SDK v6 and `experience_context`. The capture's PayPal fee is booked in the ledger. Payouts use `sender_batch_id` idempotency, webhooks are verified, and publishers can Log in with PayPal. All in the sandbox.
- **Ledger:** Postgres, double-entry, integer micro-dollars, one transaction per fare (wallet −2¢, publisher +1.9¢, BotFare +0.1¢).
- **AI:** Claude by default; one adapter also runs OpenAI, Gemini, Grok, Groq, OpenRouter and Ollama models, and the live demo runs Groq's `openai/gpt-oss-120b`. Every model answer is zod-validated, and the money moves only in code.
- Next.js, Express, Drizzle, AG Studio analytics (custom widgets, theme, AI assistant), an MCP server, Render, and **Claude Code** with the PayPal and APIMatic plugins.

## Challenges we ran into

- Fitting a fiat, prepaid model into x402's blockchain-shaped interfaces without forking the SDK.
- Proving delivery for a 2¢ dispute (RFC 9530 content digests attested by the publisher's middleware).
- Charging AI agents without ever charging people.
- Free AI tiers that rate-limit and invent tool names.

## Accomplishments that we're proud of

- A real sandbox top-up ($5.00, $0.66 fee) and a real Payouts batch ($11.72, `SUCCESS`).
- 826 unit and database tests, plus 30 end-to-end checks on real processes.
- Fare Court refunding a 2¢ stub page in 2 seconds on a free model.
- Anyone can try it in 2 minutes from `/judge`.

## What we learned

Micropayments failed less on technology than on the cost of deciding (Szabo, 1999). x402 removes the technical cost and batching removes PayPal's fee; AI removes the decision cost, as long as code, not the model, holds the money.

## What's next

- **Allowance:** plain-English spending rules for agents, with phone approvals.
- Paid MCP tools.
- x402 Bazaar discovery.
- A tamper-evident ledger.
- Proposing `prepaid` on `paypal:*` to the x402 Foundation.

---

## How BotFare meets the judging criteria

| Criterion | Where to look |
| --- | --- |
| Technological Implementation (PayPal + AI) | x402 plug-in on the official SDK (`packages/x402-paypal`), the PayPal client (`packages/paypal`), the double-entry ledger (`packages/core`), Fare Court and Fare Advisor with policy in code, signed receipts |
| Design | A ticket-booth look (Admit-bot logo, paper, ink and ticket yellow), 60-second publisher setup, wallet with PayPal top-up, the wire inspector on `/agent`, AG Studio analytics in the BotFare theme |
| Potential Impact | Small publishers and API owners earn from AI traffic through the PayPal accounts they already have; agents pay cents, not 49¢ fees |
| Quality of the Idea | x402 for PayPal's 440 million accounts; AI on the decisions too small for a person |
| Presentation | `/judge` (try it in 2 minutes), the video, a 60-second README intro with a quick start, and the money landing in a PayPal sandbox account |

## Built With

paypal, paypal-orders, paypal-js-sdk-v6, paypal-payouts, paypal-webhooks, log-in-with-paypal, x402, anthropic, claude, claude-code, groq, ag-grid, ag-studio, apimatic, render, next.js, react, express, typescript, postgresql, drizzle, docker, mcp

## Try it

- **Live app (try it in 2 minutes):** https://botfare-web.onrender.com/judge
- **Demo publisher:** Saffron & Salt, our demo recipe blog, at https://botfare-demo.onrender.com (a browser reads free; `curl -i -H 'x-botfare-agent: 1' https://botfare-demo.onrender.com/recipes/weeknight-red-lentil-dal` gets a 402)
- **Code:** https://github.com/Sajjad21990/botfare (MIT; install from GitHub, not on npm yet)
- **Run locally:** `docker compose -f docker-compose.full.yml -p botfare-judge up --build -d --wait`, then open http://localhost:3300/judge.
- **Test logins:** the `/judge` page signs you in as the demo publisher or agent owner, with no password. PayPal sandbox buyer for a top-up (test money): on `/judge` under **PayPal test account** (click **Show** for the password).

## Sponsor tools

AG Grid (AG Studio), APIMatic (Context Plugin), Render.
