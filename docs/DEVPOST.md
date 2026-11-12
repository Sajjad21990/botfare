# BotFare Devpost text

Paste each section into the matching Devpost field.

Name: BotFare

Tagline: Every bot pays its fare. x402 for PayPal's 440 million accounts.

---

## Inspiration

AI agents now read the web for people, and small publishers lose the clicks that paid for the writing. With a Google AI Overview on the page, people click a result on 8% of visits instead of 15% ([Pew Research Center, 2025](https://www.seroundtable.com/pew-google-ai-overviews-39808.html)). x402, the open standard for paying per request, settles only in stablecoins, and a PayPal payment for a 2¢ recipe costs about 49¢ in fees. We wanted an agent to pay 2¢ and the cook who wrote it to get paid in PayPal.

## What it does

- Publishers add one line of middleware, set prices in a dashboard and get paid through PayPal Payouts.
- People read pages free. AI agents pay.
- Agent owners top up a USD wallet with PayPal and give each agent a key with a budget.
- An agent gets an HTTP 402 with the price, signs a payment and receives the page. The publisher gets 95% and BotFare keeps 5%.
- One $5 top-up pays one PayPal fee ($0.66) and covers 250 recipes at 2¢, instead of 250 fees.
- A research agent buys or skips each page and gives a reason.
- Fare Court refunds a bad 2¢ purchase on its own when the AI judge is at least 80% sure. Unsure cases go to the publisher.
- Fare Advisor suggests better prices from agents' reasons, and the publisher clicks Apply.
- Every payment, delivery and refund gets a signed receipt that anyone can check on `/verify`.

## How we built it

- PayPal Orders v2 and JS SDK v6 for top-ups, Payouts for publishers, verified webhooks, Log in with PayPal. All sandbox.
- A plug-in for the official x402 SDK 2.30.0 (scheme `prepaid`, network `paypal:sandbox`). No fork.
- A double-entry Postgres ledger in integer micro-dollars.
- Ed25519 signed receipts with a public key set (JWKS).
- OpenAI `gpt-5-mini` runs the live demo (a research run takes about 20 seconds). Claude is the default when its key is set. Code, not the model, moves the money.
- AG Studio analytics with custom widgets, our theme and an AI assistant.
- An MCP server so any agent can pay.
- Next.js, Express and Drizzle, deployed on Render.
- Built with Claude Code, PayPal's Claude Code plugin and APIMatic ContextMatic.

## Challenges we ran into

- Fitting a prepaid PayPal balance into x402's blockchain-shaped interfaces without forking the SDK.
- Proving what was delivered in a 2¢ dispute. The middleware attests a hash of the exact bytes sent.
- Charging AI agents without ever charging a person.

## Accomplishments that we're proud of

- Sandbox money moves through PayPal end to end: a $5.00 top-up and an $11.72 Payouts batch that reached `SUCCESS`.
- 581 unit tests and 277 database tests, plus end-to-end checks on real processes.
- Anyone can try it in 2 minutes from `/judge`.

## What we learned

- Micropayments failed on the cost of deciding, not on technology. AI can make the small decisions.
- The model can decide, but only code should hold the money.
- Batching makes PayPal work for 2¢ payments.

## What's next

- Plain-English spending rules for agents, with approvals on your phone.
- Paid MCP tools.
- Proposing `prepaid` on `paypal:*` to the x402 Foundation.

## Try it

- Live app: https://botfare-web.onrender.com/judge (try it in 2 minutes)
- Demo publisher, a recipe blog: https://botfare-demo.onrender.com
- Code: https://github.com/Sajjad21990/botfare (MIT)
- `/judge` signs you in as the demo publisher or agent owner. No password needed.
- This is the PayPal sandbox, so it is test money only. The PayPal sandbox buyer for a top-up is shown on `/judge` and in the wallet.

## Judging criteria

| Criterion | Where to look |
| --- | --- |
| Technological Implementation | PayPal Orders, Payouts, webhooks and login; the x402 plug-in; the ledger; AI with limits in code |
| Design | `/judge` tour, one-line setup, PayPal top-up, Payment details and Check the receipts yourself on `/agent`, AG Studio analytics |
| Potential Impact | Publishers earn from AI traffic through PayPal accounts they already have |
| Quality of the Idea | x402 for PayPal's 440 million accounts, with AI making decisions too small for a person |
| Presentation | `/judge`, the [video](https://youtu.be/Opl81NyyIvw), a short README and money landing in a PayPal sandbox account |

## Built With

paypal, paypal-orders, paypal-js-sdk-v6, paypal-payouts, paypal-webhooks, log-in-with-paypal, x402, openai, anthropic, claude, claude-code, ag-grid, ag-studio, apimatic, render, next.js, react, express, typescript, postgresql, drizzle, docker, mcp

## Sponsor tools

AG Grid (AG Studio), APIMatic (ContextMatic), Render.

Pay the fare, pal.
