# Day-0 spike results

Run on Sun 8 Nov 2026. Each script prints PASS or FAIL; rerun with `pnpm spike:<nn>`.

| Script | What it proves | Result | Notes |
| --- | --- | --- | --- |
| `01-oauth` | Sandbox client credentials work | Pending | Needs `.env` with the sandbox app's client ID and secret |
| `02-topup` / `02b-capture` | A $5.00 PayPal top-up can be approved and captured; the fee is visible | Pending | Approve as the agent-owner sandbox account |
| `03-payout` | A $0.25 Payouts batch reaches the publisher sandbox account | Pending | Needs Payouts enabled on the app |
| `04-jws` | Agent Ed25519 authorizations verify; tampered, wrong-key and expired ones fail | **PASS** (4/4) | jose 6.2.15, `EdDSA`, `typ: x402-prepaid+jwt` |
| `05-x402` | The `prepaid` scheme on `paypal:sandbox` works as a plug-in for the official `@x402/express` + `@x402/fetch` + `x402Facilitator` (2.30.0) | **PASS** (6/6) | 402 with V2 header; paid 200 with `PAYMENT-RESPONSE`; 95/5 split; replay rejected (`invalid_prepaid_nonce_used`); handler 500 not charged; ledger sums to zero |

## Spike 05 wire sample

Decoded `PAYMENT-REQUIRED` from the official `@x402/express` middleware:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://127.0.0.1:54562/articles/burr-basics",
    "description": "Burr grinders, explained",
    "mimeType": "text/html"
  },
  "accepts": [
    {
      "scheme": "prepaid",
      "network": "paypal:sandbox",
      "amount": "3",
      "asset": "USD",
      "payTo": "site_demo",
      "maxTimeoutSeconds": 60,
      "extra": {}
    }
  ]
}
```

Decoded `PAYMENT-RESPONSE` after the paid retry:

```json
{
  "success": true,
  "payer": "ak_spike",
  "transaction": "rcpt_2768f6d39c084deb",
  "network": "paypal:sandbox",
  "amount": "3"
}
```

The 402 body carries the free preview (`unpaidResponseBody`), which the research agent will read before deciding to pay.

## Decision

The plug-in route works, so we build on the official x402 SDK. The fallback (our own middleware and fetch wrapper) is not needed.
