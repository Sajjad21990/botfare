# BotFare task tracker

**Every bot pays its fare.** This file is the single place to see what is done, what is in progress, and what is left. It is updated at every milestone.

**Deadline:** Thu 12 Nov 2026, 12:00 pm PST (Fri 13 Nov, 1:30 am IST). **Target:** submit by Thu 8 pm IST.

**Last updated:** Sun 8 Nov 2026, late night IST (agent detection done)

## Overview

| Phase | Plan day | Status | Progress |
| --- | --- | --- | --- |
| 0. Setup and proof | Sun 8 | ✅ Done | 10 / 10 |
| 1. Protocol end to end | Mon 9 | ✅ Done (a day early) | 9 / 9 |
| 2. Real money and dashboards | Tue 10 | ✅ Done (two items need you) | 9 / 11 |
| 3. Agent detection, AI and polish | Wed 11 | 🔄 In progress (detection done) | 3 / 9 |
| 4. Deploy to Render | Wed 11 (last build step) | ⏳ Not started | 0 / 5 |
| 5. Submission | Thu 12 | ⏳ Not started | 0 / 9 |

**Overall: about 58% done** (31 of 53 items), and ahead of the plan by about two days.

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
| ⏳ | 👤 Approve one wallet top-up in the browser with the sandbox agent-owner account | Needed to prove the v6 button end to end |
| ⏳ | 👤 Optional: AG Studio 45-day trial key in `.env` as `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` | Removes the watermark |

## Phase 3: Agent detection, AI and polish 🔄

| | Task | Notes |
| --- | --- | --- |
| ✅ | **Agent detection layer** in `botfare()`: signed agents (Web Bot Auth, RFC 9421 Ed25519; the SDK signs every request, BotFare publishes the key directory), edge bot scores (Cloudflare, Akamai headers, configurable), crawler impostor check (677 published IP prefixes), automation heuristics (HTTP client and headless user agents, missing browser headers); the signal travels in `extra.botfareSignal` and is stored on each receipt | Score-based: "pay, or prove you're human", never a hard block. Real Chrome, Firefox and Safari headers are never charged. Left out on purpose: datacenter IP lists and request rates. `packages/express/src/detection`; e2e 16/16 incl. 7 detection checks; SDK-to-middleware interop test |
| ✅ | Human escape hatch: Cloudflare Turnstile "Reading as a human? Continue free" | `POST /__botfare/human` sets a signed 24 h pass; Crema Notes uses Cloudflare's test key (always passes). A real widget key is optional before the live demo. Test site keys always use Cloudflare's test secret and a real key never accepts a test secret (logged once); while the facilitator is unreachable a suspected human still gets the check (503 page) |
| ✅ | Dashboard "Bot detection" panel: strictness, edge settings, revenue recovered per signal | Site card tab + "Revenue by detection signal" in analytics; `pnpm seed` sets Crema Notes to standard |
| ⏳ | Research agent: `get_offer` / `buy` / `skip` / `finish`, wire inspector, cost meter, citations linked to receipts | 👤 needs an Anthropic API key |
| ⏳ | `/judge` page: one-click demo flows and sandbox logins | |
| ⏳ | MCP server for Claude Desktop and Claude Code (should) | `get_offer`, `fetch_paid`, `wallet_balance`, `recent_receipts` |
| ⏳ | Log in with PayPal for publishers (should) | 👤 enable it on the sandbox app |
| ⏳ | Full-stack Docker Compose so judges can run everything locally (should) | |
| ⏳ | Polish: empty, loading, error and mobile states (hide revoked test keys in the wallet); feature freeze at 10 pm IST | |

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
