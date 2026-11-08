# BotFare

Pay-per-request for AI agents, settled on PayPal. Tagline: "Every bot pays its fare." Pitch: "BotFare: x402 for PayPal's 440 million accounts." Video close: "Pay the fare, pal."

Solo entry for the PayPal AI Hackathon (Devpost). **Deadline: Thu 12 Nov 2026, 12:00 pm PST (Fri 13 Nov, 1:30 am IST); submit by Thu 8 pm IST.** Prefer simple, working, demo-ready code over clever code. The full proposal and day plan live in `docs/PLAN.md`.

## Product
- **Publishers** add one line of middleware, set prices in the dashboard, and get paid through PayPal Payouts.
- **Agent owners** top up a USD balance with PayPal and give each agent a key with a budget (daily cap, per-request max, allowed sites).
- **BotFare** settles each request over x402 in a double-entry ledger, keeps 5%, and pays publishers in Payouts batches.

## How payments travel (x402 V2)
- BotFare's PayPal payment type is the x402 scheme **`prepaid`** on network **`paypal:sandbox`** (asset `USD`, `amount` in integer cents), built as a plug-in for the official `@x402/*` SDK, pinned to exactly 2.30.0. See `packages/x402-paypal`.
- Publishers run `@x402/express` with the plug-in; agents run `@x402/fetch` with it; the facilitator uses `x402Facilitator` from `@x402/core`.
- The agent signs each payment as an Ed25519 JWS (`typ: x402-prepaid+jwt`, `kid` = agent key ID) and picks the nonce itself; the facilitator makes nonces single-use and authorizations expire within 60 s.
- Order is verify → handler → settle, so agents are never charged for failed responses.
- Fallback rule: our own x402-compatible middleware/fetch wrapper only if the plug-in route blocks us. Spike 05 passed on 8 Nov, so it is not needed.

## Layout (target; packages are added as each phase needs them)
```
apps/web             Next.js: dashboards, wallet, research agent, /judge, facilitator /api/x402/*, PayPal webhooks
apps/demo            Express demo publisher (original articles + /api/brew-ratio) behind @botfare/express
packages/x402-paypal the plug-in: client, server and facilitator parts, JWS helpers, ledger port, in-memory ledger
packages/contracts   shared wire contracts: IDs, site auth header, site config + pricing rules, agent key string, preview
packages/express     botfare({ siteId, siteSecret }): humans free, dashboard prices (cached site config), @x402/express
packages/sdk         createBotFareAgent(): getOffer() + paying fetch on @x402/fetch
packages/mcp         MCP server: get_offer, fetch_paid, wallet_balance, recent_receipts
packages/paypal      typed PayPal REST client (sandbox only)
packages/core        Drizzle schema, Postgres ledger implementing the ledger port, services (payouts next)
scripts/spike        Day-0 PayPal and x402 spikes
scripts/seed.ts      local demo data (publisher, site, wallet, agent key) -> .env
scripts/e2e.ts       Phase 1 end-to-end PASS/FAIL checks on real processes
```

## Commands
- `pnpm install` · `pnpm typecheck` · `pnpm lint` (Biome) · `pnpm format` · `pnpm test` (vitest; `*.db.test.ts` run against `botfare_test` in the "db" project)
- `pnpm db:up` / `pnpm db:down`: Postgres 17 in Docker (`botfare` and `botfare_test` databases)
- `pnpm db:migrate`: apply `packages/core/drizzle` to `DATABASE_URL` (regenerate with `pnpm --filter @botfare/core db:generate`)
- `pnpm seed`: demo publisher, Crema Notes site (secret rotated each run), $5 wallet, agent key; writes `BOTFARE_URL`, `BOTFARE_SITE_ID`, `BOTFARE_SITE_SECRET`, `BOTFARE_AGENT_KEY` to `.env`
- `pnpm e2e`: starts the web app (:3000, reused if up) and the demo (:4000), runs the Phase 1 PASS/FAIL checks, stops both; `E2E_VERBOSE=1` streams their logs
- `pnpm dev:web` / `pnpm dev:demo`: run the app or the demo (both read the root `.env`)
- `pnpm --filter @botfare/web build`: production build of the app
- `pnpm spike:01`…`spike:05`: Day-0 spikes; results in `docs/SPIKE_RESULTS.md`
- `render.yaml`: Render Blueprint (botfare-web, botfare-demo, botfare-db); not deployed yet
- `pnpm --filter @botfare/web dev` (Next.js on :3000) · `pnpm --filter @botfare/demo dev` (demo publisher)
- Workspace packages export TypeScript source; Next.js transpiles them (`transpilePackages`), everything else runs on tsx.
- `apps/web` uses TypeScript 5.9 (Next's type checker); the rest of the repo uses TypeScript 7.

## Rules
- PayPal **sandbox only** (`https://api-m.sandbox.paypal.com`); never call live endpoints.
- Secrets only in `.env` (gitignored); keep `.env.example` complete with a comment per variable.
- Every PayPal POST sends `PayPal-Request-Id`; cache OAuth tokens; log calls without secrets.
- Credit wallets only from a confirmed capture; every money event is idempotent (capture ID, `sender_batch_id`, nonce).
- Ledger: double-entry in integer micro-dollars (1 USD = 1,000,000); balances change only through ledger postings; all entries sum to zero; wallets never go negative.
- The LLM never holds PayPal credentials or agent private keys; validate all LLM output with zod.
- Docker only for local infrastructure (Postgres); apps run natively with pnpm.
- Use fictional site and product names in demo content (no third-party trademarks).
- Public repo at submission, MIT license. Commit at each milestone.

## Decisions (8 Nov)
1. x402 plug-in (`prepaid` on `paypal:sandbox`) for the official SDK, not an imitation; own code only as fallback.
2. Agent-chosen nonces; facilitator enforces single use per key + 60 s expiry.
3. Settle after a successful response (SDK `authorization` flow); refunds are a publisher action.
4. One demo publisher service (articles + brew API).
5. Prices live in the dashboard and reach the middleware through the site config (built: a per-request x402 route from the cached config instead of `DynamicPrice`, because the SDK's description and mimeType are fixed per route).
6. Auth: judge personas + Log in with PayPal (verified payout email); no magic links.
7. Research agent tools: `get_offer` (free 402 read incl. preview from `unpaidResponseBody`), `buy`/`skip` with a reason, `finish`; hard caps in SDK spend controls and the facilitator.
8. Wire inspector next to the agent (PAYMENT-REQUIRED → signed payment → PAYMENT-RESPONSE).
9. PayPal: JS SDK v6, Orders v2 `experience_context`, PayPal fee booked from the capture, Payouts with `sender_batch_id`, webhooks, Log in with PayPal.
10. Publisher analytics built in AG Studio (theme, custom widgets, layout, Claude adapter) for the AG Grid prize.
11. Deploy to Render on Monday; paid plans from credits so nothing sleeps or expires before judging ends (15 Dec).
12. README and Devpost text map features to the five judging criteria; `docs/PROTOCOL.md` documents the scheme.
13. Record B-roll as soon as top-up and payout work.
14. MCP server is a "should", first job Wednesday evening.
