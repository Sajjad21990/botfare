# @botfare/mcp

An MCP server that lets Claude Desktop and Claude Code read pages and APIs that charge AI agents
per request through BotFare. It pays from your prepaid, PayPal-funded BotFare balance, within the
limits you set on the agent key, and returns each page as readable text with a receipt ID.

The agent key stays in this local process. It signs every request (Web Bot Auth HTTP Message
Signature) and every payment (an Ed25519 JWS for the x402 `prepaid` scheme on `paypal:sandbox`).
Claude never sees the key, only the tool results.

## Tools

| Tool | What it does | Moves money? |
| --- | --- | --- |
| `get_offer(url)` | One unpaid request: the price, the publisher's site and a free preview (title, excerpt, length), and whether it fits your limits. | No |
| `fetch_paid(url, max_price_usd?)` | Fetches the URL and pays if it asks for payment, then returns readable text (HTML becomes plain text, JSON is pretty-printed) and the receipt ID. Free pages are read without paying. | Yes, at most the cap below |
| `wallet_balance()` | Wallet balance, today's spend against the daily cap, the per-request max and the allowed sites. | No |
| `recent_receipts(limit?)` | The key's latest payments: time, site, URL, amount, status and receipt ID (1-50, default 10). | No |

`fetch_paid` pays at most **min(`max_price_usd`, the key's per-request max, what is left of its
daily cap, the wallet balance)**. A higher price is refused before anything is signed, so no
money moves. Without `max_price_usd` the ceiling is the key's per-request max, or $0.10 when the
key has none (`BOTFARE_MAX_PRICE_USD` changes that default). BotFare's facilitator enforces the
same limits again when it settles, and it settles only after the publisher answers successfully,
so a failed response is never charged.

The server tells Claude to call `get_offer` first and to buy only what the preview shows is
worth it.

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

## How it authenticates to BotFare

`wallet_balance` and `recent_receipts` call BotFare's agent API:

- `GET /api/agent/wallet` returns
  `{ keyId, keyName, balanceUsd, spentTodayUsd, dailyCapUsd, perRequestMaxUsd, allowedSiteIds }`.
- `GET /api/agent/receipts?limit=N` (1-100, default 10) returns
  `{ keyId, receipts: [{ receiptId, time, site, siteId, url, amountUsd, status }] }`.

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

## Tests

```sh
npx vitest run packages/mcp
```

The tests run every tool against an in-process publisher (`@x402/express`), facilitator
(`x402Facilitator` with an in-memory ledger) and a stand-in agent API that verifies signatures,
and start the real stdio server through an MCP client.
