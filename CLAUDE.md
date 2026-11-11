# BotFare

Pay-per-request for AI agents, settled on PayPal. Tagline: "Every bot pays its fare." Pitch: "BotFare: x402 for PayPal's 440 million accounts." Video close: "Pay the fare, pal."

Solo entry for the PayPal AI Hackathon (Devpost). **Deadline: Thu 12 Nov 2026, 12:00 pm PST (Fri 13 Nov, 1:30 am IST); submit by Thu 8 pm IST.** Prefer simple, working, demo-ready code over clever code. The full proposal and day plan live in `docs/PLAN.md`.

## Product
- **Publishers** add one line of middleware, set prices in the dashboard, and get paid through PayPal Payouts.
- **Agent owners** top up a USD balance with PayPal and give each agent a key with a budget (daily cap, per-request max, allowed sites).
- **BotFare** settles each request over x402 in a double-entry ledger, keeps 5%, and pays publishers in Payouts batches.
- **AI on every side of the fare** (PLAN "Decisions (9 Nov)"): Claude makes the micro-decisions (buy or skip, was it as promised, what should it cost); code moves the money and enforces policy. **Fare Court** arbitrates 3¢ disputes; **Fare Advisor** prices from offers, declines, citations and disputes.
- **Signed receipts** (PLAN decision 18): BotFare signs payment, delivery and refund statements (Ed25519 JWS) so anyone can verify them offline with its public JWKS, on `/verify`, in the SDK and MCP, and in the research agent's Verify sources panel.

## How payments travel (x402 V2)
- BotFare's PayPal payment type is the x402 scheme **`prepaid`** on network **`paypal:sandbox`** (asset `USD`, `amount` in integer cents), built as a plug-in for the official `@x402/*` SDK, pinned to exactly 2.30.0. See `packages/x402-paypal`.
- Publishers run `@x402/express` with the plug-in; agents run `@x402/fetch` with it; the facilitator uses `x402Facilitator` from `@x402/core`.
- The agent signs each payment as an Ed25519 JWS (`typ: x402-prepaid+jwt`, `kid` = agent key ID) and picks the nonce itself; the facilitator makes nonces single-use and authorizations expire within 60 s.
- Order is verify → handler → settle, so agents are never charged for failed responses.
- Fallback rule: our own x402-compatible middleware/fetch wrapper only if the plug-in route blocks us. Spike 05 passed on 8 Nov, so it is not needed.

## Layout (target; packages are added as each phase needs them)
```
apps/web             Next.js: dashboards, wallet, research agent (/agent, POST /api/research), /judge, Log in with
                     PayPal (/api/auth/paypal/*), facilitator /api/x402/* (incl. receipts/:id/attest, telemetry),
                     agent API /api/agent/* + /api/disputes, /api/offers/decline, /api/citations, Fare Court judge
                     (lib/server/fare-court.ts), Disputes page, Fare Advisor (lib/server/fare-advisor.ts), PayPal webhooks,
                     signed receipts: /.well-known/botfare-receipt-keys.json, /api/receipts/:id/statements
                     (lib/server/receipt-statements.ts), /verify (components/verify), Verify sources (components/agent)
apps/demo            Express demo publisher Saffron & Salt, a recipe blog (original recipes, techniques, a meal plan, a
                     cookbook chapter + /api/nutrition) behind @botfare/express; /recipes/sourdough-starter serves
                     paying agents a subscribe stub (FARE_COURT_STUB_SLUG, FARE_COURT_STUB_PATH)
packages/x402-paypal the plug-in: client, server and facilitator parts, JWS helpers, ledger port, in-memory ledger
packages/contracts   shared wire contracts: IDs, site auth header, site config + pricing rules, agent key string, preview;
                     ./fare: Content-Digest, declared offer, disputes/verdicts/DISPUTE_POLICY, declines, citations, telemetry;
                     ./receipts: statement schemas, verifyStatement, JWKS path, offerDigest, sources manifest, checkAnswerSource
packages/express     botfare({ siteId, siteSecret }): humans free, dashboard prices (cached site config), @x402/express,
                     agent detection (src/detection), the Turnstile human check (/__botfare/human), extra.botfareOffer,
                     proof of delivery (src/delivery-proof.ts) and offer telemetry (src/telemetry.ts)
packages/sdk         createBotFareAgent(): getOffer() + paying fetch on @x402/fetch, dispute(), decline(),
                     reportCitations(), verifyReceipt(), fetchStatements(); signs every request (Web Bot Auth)
packages/mcp         MCP server: get_offer, fetch_paid, decline_offer, dispute_purchase, verify_receipt, wallet_balance,
                     recent_receipts
packages/paypal      typed PayPal REST client (sandbox only)
packages/core        Drizzle schema, Postgres ledger implementing the ledger port, services (payouts, Fare Court:
                     services/fare-court.ts, Fare Advisor: services/fare-advisor.ts, signed receipts:
                     receipt-keys.ts + services/receipt-statements.ts)
scripts/spike        Day-0 PayPal and x402 spikes
scripts/seed.ts      local demo data (judge personas, site, wallet, agent key) -> .env
scripts/traffic.ts   demo traffic for the dashboards (seed:traffic); lib/fare-story.ts adds the Fare Court/Advisor story
scripts/payouts.ts   daily Payouts batch + status sync (payouts:run; Render cron)
scripts/e2e.ts       end-to-end PASS/FAIL checks (payments, signed receipts, agent detection, Fare Court, Fare Advisor)
                     on real processes
docker-compose.full.yml + docker/   one-command judge stack (project botfare-judge; docker/README.md)
```

## Commands
- `pnpm install` · `pnpm typecheck` · `pnpm lint` (Biome) · `pnpm format` · `pnpm test` (vitest; `*.db.test.ts` run against `botfare_test` in the "db" project)
- `pnpm db:up` / `pnpm db:down`: Postgres 17 in Docker (`botfare` and `botfare_test` databases)
- `pnpm db:migrate`: apply `packages/core/drizzle` to `DATABASE_URL` (regenerate with `pnpm --filter @botfare/core db:generate`)
- `pnpm seed`: judge personas (`DEMO_PERSONAS`; publisher payout email from `PUBLISHER_PAYPAL_EMAIL`), Saffron & Salt site at `DEMO_ORIGIN` (prices `DEMO_SITE_PRICING`: recipes 2¢, techniques 5¢, meal plans 8¢, cookbook 50¢, `/api/nutrition` 1¢ for everyone; renames an older Crema Notes site and publisher email in place via `LEGACY_DEMO_*`, keeping IDs and history; secret kept while it works; `--rotate-site-secret` forces a new one; bot detection set to `CREMA_NOTES_DETECTION`: standard + Turnstile test site key), $5 wallet, agent key; writes `BOTFARE_URL`, `BOTFARE_SITE_ID`, `BOTFARE_SITE_SECRET`, `BOTFARE_AGENT_KEY` to `.env` (plus a random `BOTFARE_RECEIPT_KEY_SEED` if `.env` has none). On Render: `pnpm seed --print-secrets` in botfare-web's Shell (README "Deploy"); to move a database seeded before the recipe demo, `BOTFARE_SITE_ID=… BOTFARE_SITE_SECRET=… pnpm seed` then `pnpm seed:traffic --run-key recipes` there
- `pnpm seed:traffic`: three more agent keys ("Research agent", "Price watcher", "Newsletter bot") and ~150 paid requests over the last 14 days through `PostgresPrepaidLedger` with an injected clock; then the Fare Court and Fare Advisor story through the core services (offers shown, 50¢ cookbook chapter declines, citations of the dal recipe and the freezing guide, four attested sourdough-starter stub purchases disputed: three refunded by scripted policy verdicts, one pending for the publisher); idempotent per `--run-key` (default `demo`)
- `pnpm payouts:run`: daily PayPal Payouts batch (publishers with ≥ $1.00 and a payout email), then sync of open payouts; idempotent. Runs on Render as the `botfare-payouts` cron
- `pnpm e2e`: starts the web app (:3000, reused if up) and the demo (:4000), runs the payment, signed-receipt, agent-detection, Fare Court and Fare Advisor PASS/FAIL checks, stops both; the web app it starts has every AI provider key blanked (disputes go to the publisher), `E2E_AI=1` keeps them and adds an optional AI judge check; `E2E_VERBOSE=1` streams their logs. Ports 3000/4000 belong to the user's own dev servers: run beside them with `pnpm --filter @botfare/web build && WEB_PORT=3100 DEMO_PORT=4100 E2E_WEB=start pnpm e2e` (`next start`; Next allows one `next dev` per app directory). The human-check step calls Cloudflare's siteverify (network)
- `pnpm dev:web` / `pnpm dev:demo`: run the app or the demo (both read the root `.env`)
- Judge stack: `docker compose -f docker-compose.full.yml -p botfare-judge up --build -d --wait` (its own Postgres, setup, web on :3300, demo on :4300; web reaches the demo via `DEMO_INTERNAL_URL=http://demo:4000`); stop with `docker compose -f docker-compose.full.yml -p botfare-judge down -v`. Always pass `-p botfare-judge`: the dev Postgres (project `botfare`, volume pgdata) holds real sandbox records and is never stopped or removed
- Ports: 3000/4000 are the user's own dev servers (never kill or reuse); 3100/4100 for `pnpm e2e` beside them; 3300/4300 the judge Docker stack; 3200+ for other throwaway servers
- MCP server: `packages/mcp` (stdio; setup for Claude Desktop/Code in its README); `pnpm test` covers it
- `pnpm --filter @botfare/web build`: production build of the app
- `pnpm spike:01`…`spike:05`: Day-0 spikes; results in `docs/SPIKE_RESULTS.md`
- `render.yaml`: Render Blueprint (botfare-web, botfare-demo, botfare-payouts and botfare-demo-refresh crons, botfare-db); deployed 11 Nov: https://botfare-web.onrender.com, https://botfare-demo.onrender.com
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
- Commit messages and PR descriptions carry **no AI attribution**: no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line. This applies to every agent and subagent.

## Agent detection
- Score-based, never a hard block: "pay, or prove you're human". Real browsers are never charged; a suspected human gets the Turnstile check when the site has a key.
- Signals (strongest first): signed-agent, agent-header, known-bot, bot-impostor, edge-score, automation, payment-signature (last, so a paid retry keeps the 402's signal); `everyone` on everyone-priced paths. Sent as `extra.botfareSignal`, stored on the receipt.
- Web Bot Auth signing and verification live in one module, `@botfare/contracts/web-bot-auth`, shared by the SDK and the middleware.
- `TURNSTILE_SECRET_KEY` is optional with Cloudflare's test site key (the always-pass test secret is the fallback).
- A user agent without a `Mozilla/` token that is not a known crawler or a chat/social link-preview fetcher scores 70 (`automation`, charged at standard/strict; no human check since it is not a browser).

## Web app notes
- Session and Log in with PayPal state cookies are `Secure` only when the request is https (`X-Forwarded-Proto`, then the URL: `lib/server/secure-cookies.ts`), so Safari keeps sessions on http://localhost.
- AI providers (PLAN decision 20): Claude by default; OpenAI, Gemini, xAI, Groq, OpenRouter and Ollama through `lib/server/ai/openai-compatible.ts`, which presents the Anthropic client shape (`lib/server/ai/model-client.ts`), so the four AI modules keep one code path. Registry, default choice (`AI_PROVIDER`, then Anthropic, then the first configured) and model lists in `lib/server/ai/providers.ts`; base URLs are fixed in code, the browser never sees keys, and `/api/research` accepts only a configured provider's listed model.
- Payouts (PLAN decision 19): Withdraw now and the daily batch pay only cleared earnings (`publisherEarningsSplit`): fares clear `PAYOUT_HOLD_MS` (`DISPUTE_POLICY.windowHours` + a 10-minute margin) after purchase and stay held while a dispute is `open` or `pending_publisher` (`services/payout-hold.ts`). A refund of a receipt that is not held may use only available earnings, never the clearing reserve.
- Research agent: an AI provider + `BOTFARE_AGENT_KEY`; `DEMO_PUBLIC_URL`/`DEMO_INTERNAL_URL` rewrite the demo's origin server-side (`lib/server/demo-origin.ts`). Tests use scripted models; no live Claude runs.
- Log in with PayPal is off unless `PAYPAL_LOGIN_ENABLED=true`; return URL `<BOTFARE_URL>/api/auth/paypal/callback`.

## Fare Court and Fare Advisor
- Contracts are fixed in `packages/contracts/src/fare.ts`; add to them only append-only.
- AI output is always zod-validated. Refunds happen only through `applyVerdict`/`publisherDecide` (thresholds in `DISPUTE_POLICY`, one `refundReceipt` per receipt); prices change only through `applyPriceChange` after a publisher's Apply click.
- Without any AI provider configured: disputes go to the publisher (`pending_publisher`), the Advisor returns its funnel with `aiAvailable: false`. Tests use scripted judges/models.
- The shared demo research key (`BOTFARE_AGENT_KEY`, owned by a demo persona) gets `SHARED_DEMO_KEY_DISPUTE_LIMITS` (200 disputes/day, no dispute-rate rule; `lib/server/judge.ts`); every other key keeps `DISPUTE_POLICY`.
- Decline notes find their site by URL origin; one per key, URL and UTC day.

## Signed receipts
- The contract is `packages/contracts/src/receipts.ts` (append-only): statement schemas, `RECEIPT_JWT_TYPE`, `RECEIPT_KEYS_PATH`, `SETTLE_EXTRA_RECEIPT_KEY` (`botfareReceipt`), `receiptStatementsPath`, `verifyStatement`, `canonicalJson`/`declaredOfferDigest`, the sources manifest and `checkAnswerSource`. Every other package imports names from it; no hard-coded copies.
- Statements are records signed when things happen: the first of each kind per receipt is kept forever, never re-signed. Issuing never blocks money (`issueReceiptStatementQuietly`; missing ones are issued on read by the statements endpoint).
- The key is HKDF-derived from `BOTFARE_RECEIPT_KEY_SEED` (32+ chars, in `.env`; Render generates it); private keys never leave the server, the JWKS never has `d`. Every process that settles or refunds (web, seed:traffic, the demo refresh cron) must share the seed and `BOTFARE_URL` (the `iss`). Production (`NODE_ENV=production` or `RENDER=true`) without a seed signs nothing; development falls back to a public dev seed. Rotate by moving the old seed to `BOTFARE_RECEIPT_KEY_SEED_PREVIOUS`.
- A payment statement's `resource` is the URL the publisher's server declares in `extra.botfareResource` (dynamic extra field, read by `serverResourceUrl`); never use the agent's unsigned `PaymentPayload.resource.url`. `checkAnswerSource` fails Paid for `resource: null` or a valid refund statement.
- Verification must work offline in Node and the browser with only the public JWKS. Honest limit: a statement proves issuance, not that history was never edited (tamper-evident ledger is the stretch).

## Decisions (8 Nov)
1. x402 plug-in (`prepaid` on `paypal:sandbox`) for the official SDK, not an imitation; own code only as fallback.
2. Agent-chosen nonces; facilitator enforces single use per key + 60 s expiry.
3. Settle after a successful response (SDK `authorization` flow); refunds are a publisher action.
4. One demo publisher service (recipe pages + nutrition API; Saffron & Salt replaced the coffee site Crema Notes on 11 Nov).
5. Prices live in the dashboard and reach the middleware through the site config (built: a per-request x402 route from the cached config instead of `DynamicPrice`, because the SDK's description and mimeType are fixed per route).
6. Auth: judge personas + Log in with PayPal (verified payout email); no magic links.
7. Research agent tools: `get_offer` (free 402 read incl. preview from `unpaidResponseBody`), `buy`/`skip` with a reason (skip sends a decline note), `dispute` (Fare Court), `finish` (reports citations); hard caps in SDK spend controls and the facilitator.
8. Wire inspector next to the agent (PAYMENT-REQUIRED → signed payment → PAYMENT-RESPONSE).
9. PayPal: JS SDK v6, Orders v2 `experience_context`, PayPal fee booked from the capture, Payouts with `sender_batch_id`, webhooks, Log in with PayPal.
10. Publisher analytics built in AG Studio (theme, custom widgets, layout, Claude adapter) for the AG Grid prize.
11. Deploy to Render on Monday; paid plans from credits so nothing sleeps or expires before judging ends (15 Dec).
12. README and Devpost text map features to the five judging criteria; `docs/PROTOCOL.md` documents the scheme.
13. Record B-roll as soon as top-up and payout work.
14. MCP server is a "should", first job Wednesday evening.
