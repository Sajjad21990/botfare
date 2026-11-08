# Run the whole stack in Docker

One command starts BotFare and the Crema Notes demo publisher with a seeded database, for judges
and anyone who wants to try BotFare without installing Node or pnpm:

```sh
docker compose -f docker-compose.full.yml -p botfare-judge up --build
```

When the log shows `[demo] Crema Notes listening`, open the URLs below. To run it in the background
instead, add `-d --wait`: the command then returns once every service is healthy.

```sh
docker compose -f docker-compose.full.yml -p botfare-judge up --build -d --wait
```


| What | URL |
| --- | --- |
| The two-minute tour for judges | http://localhost:3300/judge |
| BotFare (sign in as the publisher or the agent owner, no password) | http://localhost:3300 |
| Crema Notes, the demo publisher (free for people, paid for agents) | http://localhost:4300 |
| Health checks | http://localhost:3300/api/health, http://localhost:4300/health |

Any browser works, Safari included: the session cookie is marked `Secure` only when the request
came over https, so on `http://localhost:3300` it is a plain HttpOnly cookie.

Requires Docker with Compose v2 (Docker Desktop is fine) and about 3 GB of free disk for the
images.

## What starts

| Service | Image | What it does |
| --- | --- | --- |
| `db` | `postgres:17-alpine` | The judge database, in its own volume `judge-pgdata`. Not published to the host. |
| `setup` | `Dockerfile.demo` | One-shot: `pnpm db:migrate`, `pnpm seed`, `pnpm seed:traffic`, then exits. |
| `web` | `Dockerfile.web` | The BotFare app (`next start`), container port 3000 on host port **3300**. |
| `demo` | `Dockerfile.demo` | Crema Notes behind `botfare()`, container port 4000 on host port **4300**. |

Start order: `db` healthy, then `setup` completes, then `web` is healthy (`/api/health` reports the
database as reachable), then `demo` starts. The demo talks to BotFare's facilitator over the compose
network at `http://web:3000`.

`setup` seeds the two judge personas, the Crema Notes site with its prices and bot detection, a
$5.00 demo wallet, a demo agent key, and two weeks of settled demo traffic so the dashboards have
data. It writes the site's ID and secret, the demo agent key (for the research agent) and a
generated `SESSION_SECRET` to `judge.env` on a shared volume (`judge-shared`); `web` and `demo` load that file when they start
(`docker/env-entrypoint.sh`). Secrets are never printed: the seed log shows IDs and last four
characters only. Every step is idempotent, so `up` again reuses the same site secret and agent key.

## How the web container reaches the demo

Crema Notes is registered as `http://localhost:4300`, the address browsers and agents on the host
use. Inside the `web` container `localhost` is the container itself, so `web` sets
`DEMO_PUBLIC_URL=http://localhost:4300` and `DEMO_INTERNAL_URL=http://demo:4000`: the research
agent's requests for the public origin (catalog, offers, paid reads) go to the `demo` service on
the compose network instead, with `X-Forwarded-Host: localhost:4300` so the demo still verifies the
agent's request signature for the host it was signed for. Only that exact origin is rewritten, only
server-side; the model, the page and the receipts keep the public URL
(`apps/web/src/lib/server/demo-origin.ts`). The demo itself reaches BotFare's facilitator at
`http://web:3000`. `setup` runs with `BOTFARE_JUDGE_DOCKER=1`, which drops the seed's "restart the
demo" hint (the demo starts after setup).

## Keys (optional)

Compose reads the repo's `.env` if there is one, and passes on only these variables:

| Variable | Needed for |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal top-ups and payouts (sandbox). |
| `PUBLISHER_PAYPAL_EMAIL` | The sandbox account that receives test Payouts. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | The analytics assistant and the research agent (`/agent`). |
| `JUDGE_SANDBOX_BUYER_EMAIL`, `JUDGE_SANDBOX_BUYER_PASSWORD` | The PayPal sandbox buyer (fake money) `/judge` shows for approving a top-up. |
| `PAYPAL_LOGIN_ENABLED` | Log in with PayPal; the sandbox app's return URL must be `http://localhost:3300/api/auth/paypal/callback`. |
| `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` | Removes the AG Studio watermark (build time). |
| `TURNSTILE_SECRET_KEY` | The human check; defaults to Cloudflare's always-pass test secret. |

Without them, browsing, both dashboards, the seeded analytics and paid agent requests all work;
only the PayPal and AI features need their keys. Everything else in `.env` (your local
`DATABASE_URL`, site ID and secrets) is ignored, so this stack never uses your development database.

PayPal webhooks cannot reach `localhost`, so top-ups credit on capture and payouts update through
"Refresh status", as in local development.

## Try it as an agent

An agent request without payment gets `402 Payment Required` with a `PAYMENT-REQUIRED` header
(plain `curl` counts as an agent; so does any request with an `x-botfare-agent` header):

```sh
curl -i http://localhost:4300/articles/burr-basics
curl -i -H 'x-botfare-agent: 1' 'http://localhost:4300/api/brew-ratio?dose=18'
```

To pay for real, sign in as the agent owner at http://localhost:3300, create an agent key on the
Wallet page, and use it with `@botfare/sdk` (`createBotFareAgent({ agentKey, botfareUrl:
"http://localhost:3300" })`) against `http://localhost:4300`.

## Stop and clean up

```sh
docker compose -f docker-compose.full.yml -p botfare-judge down      # stop, keep the data
docker compose -f docker-compose.full.yml -p botfare-judge down -v   # stop and delete the judge database
```

Always pass `-p botfare-judge` (the file also sets `name: botfare-judge`). The development database
from `pnpm db:up` belongs to the separate project `botfare` (volume `botfare_pgdata`, port 5432);
nothing here reads, writes or removes it. Other useful commands:

```sh
docker compose -f docker-compose.full.yml -p botfare-judge ps               # status and health
docker compose -f docker-compose.full.yml -p botfare-judge logs -f web demo # follow the app logs
docker compose -f docker-compose.full.yml -p botfare-judge exec db psql -U botfare
```

## Timings

Measured on an Apple Silicon Mac with Docker Desktop (8 Nov):

| Step | Time |
| --- | --- |
| First `--build` (pnpm install, Next build, both images) | about 1 min 50 s |
| Rebuild after a source change (pnpm store and lockfile layers cached) | about 1 min |
| Rebuild with no changes | a few seconds |
| `up` on a fresh database: migrations, seed, 147 settled demo requests, web and demo healthy | about 11 s |
| `up` again on existing data (setup reruns idempotently) | about 3 s |

## Verified

On 8 Nov, after `up --build -d --wait`: `/api/health` returned `{"ok":true,"db":true}`, `/health`
returned `{"ok":true,"site":"Crema Notes","payments":"on"}`, a bot request to an article got
`402` with `PAYMENT-REQUIRED`, a paid request through `@botfare/sdk` from the host settled
(`200`, receipt issued), and both personas signed in and loaded their dashboards. Then
`down -v` removed only the `botfare-judge` containers, volumes and network.
