# BotFare task tracker

**Every bot pays its fare.** This file is the single place to see what is done, what is in progress, and what is left. It is updated at every milestone.

**Deadline:** Thu 12 Nov 2026, 12:00 pm PST (Fri 13 Nov, 1:30 am IST). **Target:** submit by Thu 8 pm IST.

**Last updated:** Sun 8 Nov 2026, 10:30 pm IST (Phase 3b done: Fare Court and Fare Advisor built, seeded and checked end to end; e2e 25/25) · previously the same day (Fare Court and Fare Advisor added to the plan)

## Overview

| Phase | Plan day | Status | Progress |
| --- | --- | --- | --- |
| 0. Setup and proof | Sun 8 | ✅ Done | 10 / 10 |
| 1. Protocol end to end | Mon 9 | ✅ Done (a day early) | 9 / 9 |
| 2. Real money and dashboards | Tue 10 | ✅ Done (one optional item needs you) | 10 / 11 |
| 3. Agent detection, AI and polish | Wed 11 | 🔄 Built two days early; Log in with PayPal needs you | 8 / 9 |
| 3b. Fare Court and Fare Advisor (AI on every side) | Mon 9 | ✅ Done (a day early; live AI verdicts need you) | 7 / 7 |
| 4. Deploy to Render | Wed 11 (last build step) | ⏳ Not started | 0 / 5 |
| 5. Submission | Thu 12 | ⏳ Not started | 0 / 9 |

**Overall: about 73% done** (44 of 60 items); ahead of the plan. Next: deploy to Render, then run one live Fare Court verdict and one Fare Advisor recommendation with `ANTHROPIC_API_KEY` set.

**Legend:** ✅ done · 🔄 in progress · ⏳ pending · 👤 needs you · ⭐ prize-related

---

## Phase 0: Setup and proof ✅

| | Task | Proof |
| --- | --- | --- |
| ✅ | Proposal moved into the repo and revised as BotFare | [`docs/PLAN.md`](PLAN.md) |
| ✅ | Monorepo: pnpm, strict TypeScript, Biome, vitest, Postgres 17 in Docker | `pnpm typecheck && pnpm lint && pnpm test` |
| ✅ | 👤 PayPal sandbox app "BotFare" (US business account, Payouts on) and three sandbox accounts | `.env` (gitignored) |
| ✅ | 👤 PayPal and APIMatic ContextMatic Claude Code plugins connected | `/paypal:setup` passes |
| ✅ | x402 plug-in: scheme `prepaid` on network `paypal:sandbox`, works with the official `@x402/*` SDK | [`packages/x402-paypal`](../packages/x402-paypal), spike 05 |
| ✅ | Typed PayPal REST client: orders, capture with fee, refunds, Payouts, webhook verification | [`packages/paypal`](../packages/paypal) |
| ✅ | All five sandbox spikes pass: real $5.00 top-up (fee $0.66), real $0.25 Payout | [`docs/SPIKE_RESULTS.md`](SPIKE_RESULTS.md) |
| ✅ | Money-path review: 2 confirmed issues fixed (future-dated authorizations, reconcilable replays) | commit history |
| ✅ | README: problem, fee maths, x402 plug-in, architecture, PayPal APIs | [`README.md`](../README.md) |
| ✅ | Private GitHub repo; history cleaned of AI attribution | GitHub |

## Phase 1: Protocol end to end ✅

| | Task | Proof |
| --- | --- | --- |
| ✅ | Shared contracts: IDs, site auth, site config and pricing rules, agent key string, personas | [`packages/contracts`](../packages/contracts) |
| ✅ | Postgres double-entry ledger: atomic charges with row locks, 95/5 split, receipts, top-up credit, refunds | [`packages/core`](../packages/core); 20 concurrent charges → exactly the 10 affordable succeed |
| ✅ | x402 facilitator API: `/api/x402/supported`, `verify`, `settle`, `refund`, plus site config | [`apps/web`](../apps/web) |
| ✅ | `botfare()` publisher middleware: humans free, agents pay, dashboard prices | [`packages/express`](../packages/express) |
| ✅ | Agent SDK: `getOffer()` (free price check), paid `fetch()` with spend cap, wire events | [`packages/sdk`](../packages/sdk) |
| ✅ | Demo publisher "Crema Notes": 5 original articles (3¢, 5¢, a 50¢ trap) and a 1¢ API | [`apps/demo`](../apps/demo) |
| ✅ | `pnpm seed` and `pnpm e2e`: 9 of 9 checks pass on real servers | `pnpm e2e` |
| ✅ | Render Blueprint and protocol spec | [`render.yaml`](../render.yaml), [`docs/PROTOCOL.md`](PROTOCOL.md) |
| ✅ | Phase 1 review: Node 24 pin for Render, provisionable demo site, trademark clean-up | commit history |

## Phase 2: Real money and dashboards ✅

| | Task | Notes |
| --- | --- | --- |
| ✅ | App shell: shadcn/ui, signed-cookie sessions, judge personas, signed-in layout | Also fixed Tailwind not processing CSS |
| ✅ | Core money services: top-up order → capture → credit, Withdraw now, daily Payouts batch, reversals, webhook handling, dashboard read models | Tested against a mock PayPal |
| ✅ | Landing page: hero, fee maths, x402 request walkthrough | `/` |
| ✅ | ⭐ AG Studio analytics: BotFare theme, KPI layout, "Live paid requests" and "Earnings & payout" custom widgets, Claude assistant | `/publisher/analytics` |
| ✅ | Wallet: balance, PayPal JS SDK v6 top-up button, agent keys generated in the browser, receipts | `/wallet`; live sandbox order creation checked |
| ✅ | Publisher dashboard: sites, pricing editor, one-time secrets, integration snippet, earnings, Withdraw now, payout history | `/publisher` |
| ✅ | PayPal webhook endpoint and `pnpm payouts:run` | `/api/paypal/webhook` |
| ✅ | Demo traffic (~150 paid requests over 14 days), real sandbox Withdraw now, docs, Render cron | `pnpm seed:traffic`; $11.72 Payout batch VLJ8N6ZZVWKQE reached SUCCESS; `botfare-payouts` cron |
| ✅ | Phase 2 review and fixes: 7 of 8 findings confirmed and fixed (duplicate-batch double payout, UNCLAIMED handling, judge mode so shared personas can't break the demo, AI route limits, traffic rerun) | 227 tests, e2e 9/9; every route exercised over HTTP; app font and phone header fixed |
| ✅ | 👤 Approve one wallet top-up in the browser with the sandbox agent-owner account | Done: order 9LL18551JF351230G, capture 4UK59144XL504881G, $5.00 gross, $0.66 PayPal fee, wallet credited |
| ⏳ | 👤 Optional: AG Studio 45-day trial key in `.env` as `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` | Removes the watermark |

## Phase 3: Agent detection, AI and polish 🔄 (8 / 9)

| | Task | Notes |
| --- | --- | --- |
| ✅ | **Agent detection layer** in `botfare()`: signed agents (Web Bot Auth, RFC 9421 Ed25519; the SDK signs every request, BotFare publishes the key directory), edge bot scores (Cloudflare, Akamai headers, configurable), crawler impostor check (677 published IP prefixes), automation heuristics (HTTP client and headless user agents, missing browser headers); the signal travels in `extra.botfareSignal` and is stored on each receipt | Score-based: "pay, or prove you're human", never a hard block. Real Chrome, Firefox and Safari headers are never charged. Left out on purpose: datacenter IP lists and request rates. `packages/express/src/detection`; e2e 16/16 incl. 7 detection checks; SDK-to-middleware interop test |
| ✅ | Human escape hatch: Cloudflare Turnstile "Reading as a human? Continue free" | `POST /__botfare/human` sets a signed 24 h pass; Crema Notes uses Cloudflare's test key (always passes). A real widget key is optional before the live demo. Test site keys always use Cloudflare's test secret and a real key never accepts a test secret (logged once); while the facilitator is unreachable a suspected human still gets the check (503 page) |
| ✅ | Dashboard "Bot detection" panel: strictness, edge settings, revenue recovered per signal | Site card tab + "Revenue by detection signal" in analytics; `pnpm seed` sets Crema Notes to standard |
| ✅ | Research agent: `list_sources` / `get_offer` / `buy` / `skip` / `finish`, wire inspector, cost meter, citations linked to receipts | `/agent`, `POST /api/research` (SSE); budget 5¢–$1, 10¢ per page, caps in code, SDK and facilitator; tests use a scripted model. 👤 A live run needs `ANTHROPIC_API_KEY`. In Docker it reaches the demo via `DEMO_INTERNAL_URL` |
| ✅ | `/judge` page: one-click demo flows and sandbox logins | Three steps (publisher, wallet, research agent → `/agent`), curl commands for `DEMO_PUBLIC_URL`, sandbox buyer (fake money) when `JUDGE_SANDBOX_BUYER_*` is set |
| ✅ | MCP server for Claude Desktop and Claude Code (should) | [`packages/mcp`](../packages/mcp/README.md): `get_offer`, `fetch_paid`, `wallet_balance`, `recent_receipts`; agent API `/api/agent/*` authenticated by Web Bot Auth signatures |
| 🔄 | Log in with PayPal for publishers (should) | Code done and tested against a mock PayPal (`/api/auth/paypal/*`, off unless `PAYPAL_LOGIN_ENABLED=true`). 👤 Enable it on the sandbox app with the return URL `<BOTFARE_URL>/api/auth/paypal/callback` (README) |
| ✅ | Full-stack Docker Compose so judges can run everything locally (should) | `docker-compose.full.yml`, project `botfare-judge`, ports 3300/4300; Safari-safe cookies (Secure only over https) |
| ✅ | Agent-safety review: 8 findings confirmed and fixed (two were the same demo-key issue) | Linear `htmlToText` (a hostile 1 MB page took 10–50 s on the event loop, now ms); SDK cap is always min(10¢, remaining budget), unreceipted payments count; agent reads only the demo publisher and a real user's own sites; outbound guard (no redirects, no private/mapped-IPv6/DNS-to-private hosts in production); run lock per visitor; demo key $10/day, raised in place by `pnpm seed`; agent-owner wallet kept at $5 at sign-in and before each run; daily-cap refusals explained. 👤 Rerun `pnpm seed` to raise the existing demo key's cap |
| ✅ | Polish: empty, loading, error and mobile states (hide revoked test keys in the wallet); feature freeze at 10 pm IST | Wallet "Show revoked" toggle, loading skeleton, error and 404 pages, card actions stack on phones; every page checked at 375 px with no horizontal scroll. Detection: non-browser user agents (no `Mozilla/`) now pay at standard/strict, chat link previews stay free |

## Phase 3b: Fare Court and Fare Advisor (AI on every side) ✅ (7 / 7)

Why: micropayments fail on the *decision* cost, not the technology (Szabo 1999, Shirky 2000). BotFare puts AI on the decisions too small for a human, and keeps money movement in code. See [`docs/PLAN.md`](PLAN.md), "Decisions (9 Nov)".

| | Task | Notes |
| --- | --- | --- |
| ✅ | Shared contracts: dispute request and verdict, decline note, citation report, offer telemetry, declared offer fields | `packages/contracts/src/fare.ts`; one append-only addition (`IdPrefix.dispute = "dsp"`) |
| ✅ | ⭐ Fare Court, proof of delivery: middleware attests a SHA-256 `Content-Digest` (RFC 9530) of the delivered body per receipt; the offer's title and preview are declared in the requirements at settle | `extra.botfareOffer` stored on the receipt; digest hashed as the bytes pass, attested after `finish` with retries; e2e checks the attested digest equals the bytes the agent received |
| ✅ | ⭐ Fare Court, disputes: agent-signed dispute API, Claude judge (zod verdict), refund in code via the existing ledger refund when confident, publisher review otherwise, per-key dispute-rate limits | `POST /api/disputes`; judge treats offer and content as untrusted data, pre-check, own token budget; `DISPUTE_POLICY` in core (80% thresholds, 10/day, 20% rate rule, 24 h window); the shared demo key gets 200/day and no rate rule. 👤 Live verdicts need `ANTHROPIC_API_KEY` (without it every dispute goes to the publisher, as e2e checks) |
| ✅ | ⭐ Fare Court, both sides of the UI: publisher Disputes tab with the AI's reasoning; SDK `dispute()`, MCP `dispute_purchase`, research agent disputes a stub; a Crema Notes stub page for the demo | `/publisher/disputes` (review queue, offer vs delivered excerpt, accept/decline), wallet Disputes card; 3¢ `grinder-maintenance` serves paying agents a subscribe stub; seed has 3 policy refunds and 1 pending |
| ✅ | ⭐ Fare Advisor, signals: middleware offer telemetry (402s shown), agent decline notes (SDK `decline()`, MCP `decline_offer`, research agent skip reasons), citation reports from research answers, disputes | Telemetry batched every 15 s (best effort); declines once per key, URL and day; citations replace by answer ID; e2e checks all three arrive. Privacy: no IPs or user agents stored |
| ✅ | ⭐ Fare Advisor, recommendations: Claude clusters reasons per page and proposes price, preview and audience changes with projected revenue; one-click Apply; "Citations are the new clicks" metrics on the dashboard and in analytics | Fare Advisor card (funnel per rule, why agents didn't buy, checked recommendations, projection from BotFare's funnel model, confirmed Apply); AG Studio citations and declines tables and charts. e2e: Apply 50¢ → 8¢ reaches the middleware and the next capped agent buys. 👤 Live recommendations need `ANTHROPIC_API_KEY` |
| ✅ | Integration, e2e coverage, review and fixes | `pnpm seed:traffic` tells the Advisor story (premium roundup declined as "Thin listicle, not worth 50¢", burr-basics and dialing-in cited); e2e 25/25 on 3100/4100 (9 new Fare checks, optional AI check with `E2E_AI=1`); 575 unit and DB tests; build and spike 05 pass |

## Phase 4: Deploy to Render ⏳

Deploying is the last build step, by choice. It must happen by Wednesday night so the live demo can be checked before recording.

| | Task | Notes |
| --- | --- | --- |
| ⏳ | 👤 Render: New → Blueprint, connect GitHub, enter secrets | Account and $50 credits ready |
| ⏳ | Provision the demo site on Render (`pnpm seed --print-secrets` in botfare-web's Shell) | README "Deploy" |
| ⏳ | PayPal sandbox webhook on the live URL; set `PAYPAL_WEBHOOK_ID` | |
| ⏳ | Daily payouts cron live | |
| ⏳ | Live smoke test: 402 → pay → receipt, top-up, Withdraw now | |

## Phase 5: Submission ⏳

| | Task | Notes |
| --- | --- | --- |
| ⏳ | B-roll: top-up and payout landing in PayPal (record as soon as they work) | Insurance against sandbox hiccups |
| ⏳ | 👤 Demo video under 3 minutes, public on YouTube | Close: "Pay the fare, pal." |
| ⏳ | `docs/DEVPOST.md`: description mapped to the five judging criteria | |
| ⏳ | Screenshots: publisher setup, wallet top-up, agent answer with paid citations, Payouts batch | |
| ⏳ | Final README and architecture diagram check | |
| ⏳ | 👤 Make the repo public; MIT license visible | |
| ⏳ | 👤 Devpost form: Built With, sponsor tools (AG Grid, APIMatic, Render), test credentials | |
| ⏳ | 👤 APIMatic claim form | |
| ⏳ | Keep Render services and sandbox credentials running until winners are announced (~21 Dec) | |

## Backlog (later)

| | Idea | Notes |
| --- | --- | --- |
| 💡 | **Allowance**: "Give your AI agent an allowance, not your wallet." Plain-English rules compiled by AI and enforced in code, `buy_product` over MCP, phone approvals, an intent check against prompt injection, PayPal Vault for a saved PayPal account, and an authorize-then-capture hold with an Undo (void) window | Decided 9 Nov: later. Nuvei survey (1,000 US consumers): 56% would never let AI spend without approval, 76% fear fraud, 61% want spending limits. The "84% want to reverse" figure was not found; don't use it without a source |
| 💡 | Plain-English allowance on BotFare agent keys (Allowance-lite) | Smaller first step of Allowance |
| 💡 | Publishers sell answers, not pages ("Ask Crema Notes", per cited answer) | |
| 💡 | Paid MCP tools through BotFare (`@x402/mcp`) | |
| 💡 | x402 Bazaar discovery search: "every result has a price" | Needs more than one publisher to look real |

## Decisions log

| Date | Decision |
| --- | --- |
| 8 Nov | BotFare is a real x402 plug-in (`prepaid` on `paypal:sandbox`) for the official SDK; own code only as fallback (not needed) |
| 8 Nov | Postgres in Docker; apps run natively |
| 8 Nov | Aim for the AG Grid sponsor prize as well as Render and APIMatic |
| 8 Nov | No AI attribution in commits or PRs |
| 8 Nov | Deploy to Render last, after the build work |
| 8 Nov | Add the agent detection layer (edge signals, signed agents, impostor checks, Turnstile escape hatch) after Phase 2 |
| 8 Nov | One Web Bot Auth module (`@botfare/contracts/web-bot-auth`) for the SDK signer and the middleware verifier; Cloudflare's sf-string `Signature-Agent` form |
| 8 Nov | Sites created before detection keep their behaviour (`chargeKnownBots` on → known-bots, off → off); new sites start at known-bots; Crema Notes runs at standard |
| 9 Nov | AI on every side of the fare: build Fare Court (AI micro-dispute arbitration with digest-attested delivery) and Fare Advisor (pricing from agents' decline reasons, paid, cited and disputed reads) now; Allowance moves to the backlog |
| 8 Nov (evening) | Fare Court's per-key limits do not fit the shared demo research key every judge uses: it gets 200 disputes a day and no dispute-rate rule, so instant refunds keep working for the next judge; every other key keeps `DISPUTE_POLICY` |
