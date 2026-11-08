# @botfare/mcp

An MCP server that lets Claude Desktop and Claude Code read pages and APIs that charge AI agents
per request through BotFare. It pays from your prepaid, PayPal-funded BotFare balance, within the
limits you set on the agent key, and returns each page as readable text with a receipt ID and
BotFare's signed receipt for the payment.

The agent key stays in this local process. It signs every request (Web Bot Auth HTTP Message
Signature) and every payment (an Ed25519 JWS for the x402 `prepaid` scheme on `paypal:sandbox`).
Claude never sees the key, only the tool results.

## Tools

| Tool | What it does | Moves money? |
| --- | --- | --- |
| `get_offer(url)` | One unpaid request: the price, the publisher's site and a free preview (title, excerpt, length), and whether it fits your limits. | No |
| `fetch_paid(url, max_price_usd?)` | Fetches the URL and pays if it asks for payment, then returns readable text (HTML becomes plain text, JSON is pretty-printed), the receipt ID, BotFare's signed payment statement and a one-line check of its signature. Free pages are read without paying. | Yes, at most the cap below |
| `decline_offer(url, category, reason)` | Skips an offer and tells the publisher why, in one sentence (`too_expensive`, `irrelevant`, `low_quality_preview`, `already_have`, `over_budget`, `other`). Free and best effort; it feeds the publisher's Fare Advisor. | No |
| `dispute_purchase(receipt_id, reason, note?)` | Fare Court buyer protection: disputes a purchase whose content clearly does not match its offer (`stub_or_paywall`, `error_page`, `truncated`, `unrelated`, `not_as_described`, `other`). Submits the exact bytes this server received; an AI judge compares them with the declared offer. Confident cases are refunded in seconds, unsure ones go to the publisher. | Only back to you (a refund) |
| `verify_receipt(receipt_id?, statement?)` | Checks BotFare's signed statements offline against its published keys: with `receipt_id`, every statement BotFare holds for it (payment, delivery, refund), plus whether the bytes this server read match the publisher's attested digest; with `statement`, that one JWS. Returns the verified claims. | No |
| `wallet_balance()` | Wallet balance, today's spend against the daily cap, the per-request max and the allowed sites. | No |
| `recent_receipts(limit?)` | The key's latest payments: time, site, URL, amount, status and receipt ID (1-50, default 10). | No |

`fetch_paid` pays at most **min(`max_price_usd`, the key's per-request max, what is left of its
daily cap, the wallet balance)**. A higher price is refused before anything is signed, so no
money moves. Without `max_price_usd` the ceiling is the key's per-request max, or $0.10 when the
key has none (`BOTFARE_MAX_PRICE_USD` changes that default). BotFare's facilitator enforces the
same limits again when it settles, and it settles only after the publisher answers successfully,
so a failed response is never charged.

The server tells Claude to call `get_offer` first, then decide: `fetch_paid` to buy what the
preview shows is worth it, or `decline_offer` with a short reason to skip it. After a purchase it
calls `dispute_purchase` only when the content clearly is not what the offer declared (a
"subscribe to keep reading" stub, a paywall or login wall, an error page, or an unrelated page),
never because a matching page was merely less useful than hoped.

### Disputes and the delivered bytes

The publisher's `botfare()` middleware attests a SHA-256 digest of every paid body to BotFare, so
a dispute must carry the exact bytes delivered. The server keeps those bytes in memory for its
recent paid fetches (the last 25, at most 8 MB in all, for the 24-hour dispute window) and sends
them with `dispute_purchase`; nothing is written to disk, and purchases made by another process
cannot be disputed from here. BotFare allows at most 10 disputes per key per day, and a key that
disputes a large share of its purchases has its disputes reviewed by the publisher.

What comes back is the outcome: `refunded` (the 3¢ is back in the wallet; with an AI judge this
takes a few seconds), `denied` (the AI found the page matched its offer), `pending_publisher`
(the AI was not sure, or the BotFare app has no `ANTHROPIC_API_KEY`: the publisher decides on
their Disputes page), or `invalid` (filed after 24 hours, or the bytes do not match the
publisher's digest). A refund always goes through BotFare's ledger, once per receipt; the tool
never moves money by itself.

### Signed receipts

At settlement BotFare signs a **payment statement** (an Ed25519 JWS, `typ: botfare-receipt+jwt`:
receipt, payer key, site, URL, amount, 95/5 split, time) and sends it in the x402
`PAYMENT-RESPONSE` (`extra.botfareReceipt`). When the publisher attests the bytes it delivered,
BotFare signs a **delivery statement** (the receipt and an RFC 9530 `sha-256` content digest); a
refund gets a **refund statement**. `fetch_paid` prints the payment statement and checks it:

```text
Paid $0.03 to site site_… for http://localhost:4000/articles/burr-basics. Receipt: rcpt_…
Signed receipt (BotFare payment statement, Ed25519 JWS): eyJhbGciOiJFZERTQSIs…
Signature check: verified, signed by BotFare key gNmiJcS5CZdo…: $0.03 paid to site_… for http://… by ak_… at … (publisher $0.0285, BotFare fee $0.0015)
```

`verify_receipt` fetches the public keys once (`GET /.well-known/botfare-receipt-keys.json`, a
JWKS, cached for 10 minutes and refetched when a statement names an unknown key) and a receipt's
statements (`GET /api/receipts/{receiptId}/statements`, public, no personal data), and verifies
every signature locally, requiring `BOTFARE_URL` as the issuer. The delivery statement can arrive
a moment after the purchase, so "delivery: none yet" right after `fetch_paid` is normal. A
signature proves BotFare issued the statement and cannot deny it; it does not prove BotFare never
changed its own history.

The key ID (`kid`) is the RFC 7638 thumbprint of BotFare's public key. People can check the same
receipt in a browser at `<BOTFARE_URL>/verify?receipt=rcpt_…`, which verifies the signatures in
the page with the same public keys.

The same checks are in the SDK: `agent.verifyReceipt(token)`, `agent.fetchStatements(receiptId)`
and the standalone `verifyReceipt(token, { botfareUrl })` (`@botfare/sdk`); the verifier itself is
`verifyStatement` in `@botfare/contracts/receipts`. Protocol details: [`docs/PROTOCOL.md`,
"Signed receipts"](../../docs/PROTOCOL.md#signed-receipts).

## Setup

1. Run BotFare (`pnpm dev:web`, port 3000) or use the deployed app.
2. Sign in, top up the wallet with PayPal (sandbox), then on the **Wallet** page choose
   **New agent key**. Give it a daily cap and a per-request max, and copy the `bfk_...` key. It
   is shown only once.
3. Add the server to Claude as below. Replace `/ABSOLUTE/PATH/botfare` with where this repo
   lives (after `pnpm install`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOTFARE_AGENT_KEY` | yes | The `bfk_...` agent key. Treat it like a password; revoke it on the Wallet page if it leaks. |
| `BOTFARE_URL` | no | BotFare app URL, default `http://localhost:3000`. Use exactly the host the app is served at (`localhost` and `127.0.0.1` are different hosts to a signature). |
| `BOTFARE_MAX_PRICE_USD` | no | Ceiling for `fetch_paid` when Claude gives no `max_price_usd` and the key has no per-request max. Default `0.10`. |

### Claude Code

```sh
claude mcp add --transport stdio --scope user \
  --env BOTFARE_AGENT_KEY=bfk_your_key_here \
  --env BOTFARE_URL=http://localhost:3000 \
  botfare -- /ABSOLUTE/PATH/botfare/node_modules/.bin/tsx /ABSOLUTE/PATH/botfare/packages/mcp/src/server.ts
```

Check it with `claude mcp list` (or `/mcp` inside Claude Code). Drop `--scope user` to add it to
the current project only.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`). Add:

```json
{
  "mcpServers": {
    "botfare": {
      "command": "/ABSOLUTE/PATH/botfare/node_modules/.bin/tsx",
      "args": ["/ABSOLUTE/PATH/botfare/packages/mcp/src/server.ts"],
      "env": {
        "BOTFARE_AGENT_KEY": "bfk_your_key_here",
        "BOTFARE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Restart Claude Desktop; the tools appear under the tools (hammer) menu. If Claude Desktop cannot
find `node` (it does not load your shell profile), point `command` at Node itself, for example
`"command": "/opt/homebrew/bin/node"` with
`"args": ["/ABSOLUTE/PATH/botfare/node_modules/tsx/dist/cli.mjs", "/ABSOLUTE/PATH/botfare/packages/mcp/src/server.ts"]`.

Don't start the server with `pnpm start` from an MCP client: pnpm prints a banner on stdout,
which is the protocol channel. For a quick manual run from a terminal, `pnpm --filter
@botfare/mcp start` is fine (it reads the repo's `.env`). The server logs to stderr only.

## Example prompts

With the demo publisher running (`pnpm dev:demo`, port 4000):

- "What does http://localhost:4000/articles/burr-basics cost? Show me the preview before buying
  anything."
- "Read the free catalog at http://localhost:4000/catalog.json, then research how to dial in
  espresso from those articles. Spend at most $0.20 in total and cite the receipt ID for each
  article you paid for."
- "Get a brew ratio for 15 g of coffee from
  http://localhost:4000/api/brew-ratio?method=pour-over&coffeeGrams=15, but only if it costs
  2 cents or less."
- "How much is left on my BotFare wallet today?"
- "List my last five BotFare receipts and add up what I spent."
- "Verify the signed receipt for the article you just bought: was it paid and delivered as
  attested?"
- "Buy http://localhost:4000/articles/grinder-maintenance and summarize it. If what you get is not
  the article the preview promised, dispute it." (the demo's Fare Court case: the paid response
  is a subscribe stub)

## How it authenticates to BotFare

The receipt keys and a receipt's statements are public and fetched without a signature.

`wallet_balance`, `recent_receipts`, `decline_offer` and `dispute_purchase` call BotFare's agent
API:

- `GET /api/agent/wallet` returns
  `{ keyId, keyName, balanceUsd, spentTodayUsd, dailyCapUsd, perRequestMaxUsd, allowedSiteIds }`.
- `GET /api/agent/receipts?limit=N` (1-100, default 10) returns
  `{ keyId, receipts: [{ receiptId, time, site, siteId, url, amountUsd, status }] }`.
- `POST /api/disputes` with `{ receiptId, reason, note?, contentBase64 }` returns the dispute
  outcome `{ disputeId, receiptId, status, refundedCents, verdict, message }`
  (`@botfare/contracts/fare`).
- `POST /api/offers/decline` with `{ url, priceCents, category, reason }`: one note per key,
  page and day is kept (query strings are dropped). The URL must be on a site registered with
  BotFare, at a price that site charges for it.

There is no API token. Each request carries the agent's Web Bot Auth signature
(`Signature-Input`, `Signature`, `Signature-Agent`). BotFare looks the `keyid` (the key's JWK
thumbprint) up among its active agent keys, checks `created`/`expires` and that the signature
covers BotFare's own host, and accepts each nonce once. It never fetches the `Signature-Agent`
URL. Unsigned, expired, revoked or foreign-key requests get `401` with a message saying why.

## Troubleshooting

- **"Could not reach BotFare"**: the app is not running at `BOTFARE_URL`.
- **"The signature does not verify for this server"**: `BOTFARE_URL` names a different host than
  the one the app is served at (for example `127.0.0.1` vs `localhost`), or the app's own
  `BOTFARE_URL` differs.
- **"not an active BotFare agent key"** or **"revoked"**: create a new key on the Wallet page.
- **"Refused: ... costs $X, above ..."**: the message names the limit that applied. Raise
  `max_price_usd`, the key's limits, or top up.
- **`dispute_purchase` says the publisher has not attested the receipt** (`not_attested`): the
  publisher's middleware sends its digest just after the response; the server already re-files
  twice. If it persists, the publisher runs an older `botfare()` without proof of delivery, and
  that purchase cannot be disputed.
- **`dispute_purchase` says "No content is held for receipt …"**: this process did not make that purchase (or
  restarted since), so it does not hold the delivered bytes.
- **"At most 10 disputes per agent key per day"**: the key's daily dispute limit; try again the
  next UTC day.

## Tests

```sh
npx vitest run packages/mcp
```

The tests run every tool against an in-process publisher (`@x402/express`), facilitator
(`x402Facilitator` with an in-memory ledger) and a stand-in agent API that verifies signatures,
and start the real stdio server through an MCP client.
