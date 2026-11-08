# BotFare

**Every bot pays its fare.** Pay-per-request for AI agents, settled on PayPal: x402 for PayPal's 440 million accounts.

AI agents read pages and call APIs for free, and the open standard for paying per request (x402) settles in crypto. BotFare adds PayPal to x402 as a new payment network:

- **Publishers** add one line of middleware, set a price per page or call, and get paid through PayPal Payouts.
- **Agent owners** top up a balance with PayPal and give each agent a key with a budget.
- **Agents** pay a few cents per request with a signed x402 payment; BotFare settles it in a ledger and batches the payouts, so a 3¢ page costs 3¢, not a 49¢ card fee.

> Status: Day 0 (8 Nov 2026). The x402 plug-in works end to end against the official `@x402/express` and `@x402/fetch` SDKs. Dashboards, wallet, research agent and deployment land over the next days. See [`docs/PLAN.md`](docs/PLAN.md).

## How it works

BotFare implements the x402 V2 scheme `prepaid` on network `paypal:sandbox` as a plug-in for the official x402 SDK ([`packages/x402-paypal`](packages/x402-paypal)):

1. The publisher's server answers an agent with HTTP 402 and a `PAYMENT-REQUIRED` header (`scheme: "prepaid"`, `network: "paypal:sandbox"`, `asset: "USD"`, `amount: "3"`).
2. The agent signs a single-use Ed25519 authorization and retries with `PAYMENT-SIGNATURE`.
3. BotFare's facilitator verifies it, the publisher serves the content, and BotFare settles: 95% to the publisher's earnings, 5% to BotFare, in one ledger transaction.
4. The response carries `PAYMENT-RESPONSE` with the receipt ID. Earnings leave through PayPal Payouts in batches.

## Run it locally

Requires Node 22+, pnpm 10 and Docker.

```bash
pnpm install
cp .env.example .env      # fill in PayPal sandbox credentials
pnpm db:up                # Postgres 17 in Docker
pnpm test
pnpm spike:05             # x402 plug-in end to end, no accounts needed
```

## License

[MIT](LICENSE)
