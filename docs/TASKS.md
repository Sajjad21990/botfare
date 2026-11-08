# BotFare task tracker

**Every bot pays its fare.** This file is the single place to see what is done, what is in progress, and what is left. It is updated at every milestone.

**Deadline:** Thu 12 Nov 2026, 12:00 pm PST (Fri 13 Nov, 1:30 am IST). **Target:** submit by Thu 8 pm IST.

**Last updated:** Sun 8 Nov 2026, evening IST

## Overview

| Phase | Plan day | Status | Progress |
| --- | --- | --- | --- |
| 0. Setup and proof | Sun 8 | ✅ Done | 10 / 10 |
| 1. Protocol end to end | Mon 9 | ✅ Done (a day early) | 9 / 9 |
| 2. Real money and dashboards | Tue 10 | 🔄 In progress | 5 / 11 |
| 3. Agent detection, AI and polish | Wed 11 | ⏳ Not started | 0 / 9 |
| 4. Deploy to Render | Wed 11 (last build step) | ⏳ Not started | 0 / 5 |
| 5. Submission | Thu 12 | ⏳ Not started | 0 / 9 |

**Overall: about 45% done** (24 of 53 items), and ahead of the plan by roughly one day.

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

## Phase 2: Real money and dashboards 🔄

| | Task | Notes |
| --- | --- | --- |
| ✅ | App shell: shadcn/ui, signed-cookie sessions, judge personas, signed-in layout | Also fixed Tailwind not processing CSS |
| ✅ | Core money services: top-up order → capture → credit, Withdraw now, daily Payouts batch, reversals, webhook handling, dashboard read models | Tested against a mock PayPal |
| ✅ | Landing page: hero, fee maths, x402 request walkthrough | `/` |
| ✅ | ⭐ AG Studio analytics: BotFare theme, KPI layout, "Live paid requests" and "Earnings & payout" custom widgets, Claude assistant | `/publisher/analytics` |
| 🔄 | Wallet: balance, PayPal JS SDK v6 top-up button, agent keys generated in the browser, receipts | API done; page in progress |
| 🔄 | Publisher dashboard: sites, pricing editor, one-time secrets, integration snippet, earnings, Withdraw now, payout history | API done; page in progress |
| ✅ | PayPal webhook endpoint and `pnpm payouts:run` | `/api/paypal/webhook` |
| ⏳ | Demo traffic (~150 paid requests over 14 days), real sandbox Withdraw now, docs, Render cron | Integration step |
| ⏳ | Phase 2 review and fixes | Money, authorization, flows, ops |
| ⏳ | 👤 Approve one wallet top-up in the browser with the sandbox agent-owner account | Needed to prove the v6 button end to end |
| ⏳ | 👤 Optional: AG Studio 45-day trial key in `.env` as `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` | Removes the watermark |

## Phase 3: Agent detection, AI and polish ⏳

| | Task | Notes |
| --- | --- | --- |
| ⏳ | **Agent detection layer** in `botfare()`: signed agents (Web Bot Auth style, Ed25519), edge bot scores (Cloudflare, Akamai headers, configurable), crawler impostor check (published IP ranges), automation heuristics (datacenter IPs, headless signs, rates) | First job after Phase 2. Score-based: "pay, or prove you're human", never a hard block |
| ⏳ | Human escape hatch: Cloudflare Turnstile "Reading as a human? Continue free" | Needs a free Turnstile key |
| ⏳ | Dashboard "Bot detection" panel: strictness, edge settings, revenue recovered per signal | Strong demo moment |
| ⏳ | Research agent: `get_offer` / `buy` / `skip` / `finish`, wire inspector, cost meter, citations linked to receipts | 👤 needs an Anthropic API key |
| ⏳ | `/judge` page: one-click demo flows and sandbox logins | |
| ⏳ | MCP server for Claude Desktop and Claude Code (should) | `get_offer`, `fetch_paid`, `wallet_balance`, `recent_receipts` |
| ⏳ | Log in with PayPal for publishers (should) | 👤 enable it on the sandbox app |
| ⏳ | Full-stack Docker Compose so judges can run everything locally (should) | |
| ⏳ | Polish: empty, loading, error and mobile states; feature freeze at 10 pm IST | |

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
