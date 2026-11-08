# Scheme: `prepaid` on `paypal:*`

Status: implemented in [`packages/x402-paypal`](../packages/x402-paypal) for the x402 V2 SDK (`@x402/core`, `@x402/express` and `@x402/fetch`, all pinned to 2.30.0). The only network in use is `paypal:sandbox`.

## Summary

With `prepaid`, the payer has already funded a USD balance through PayPal. For each request, the payer signs a debit authorization for exactly one payment. A facilitator checks the authorization and moves the amount between ledger accounts it controls. Money reaches and leaves PayPal in batches (Orders v2 top-ups in, Payouts out), so a 3¢ payment never needs its own PayPal transaction.

The scheme defines no on-chain asset transfer. Settlement is a posting in the facilitator's double-entry ledger, and the facilitator returns a receipt ID as the x402 `transaction`.

| Role | SDK interface | Class |
| --- | --- | --- |
| Client (agent) | `SchemeNetworkClient` | `PrepaidPayPalClient` |
| Resource server (publisher) | `SchemeNetworkServer` | `PrepaidPayPalServer` |
| Facilitator (BotFare) | `SchemeNetworkFacilitator` | `PrepaidPayPalFacilitator` |

Each class is registered for the network family `paypal:*`, or for the exact network `paypal:sandbox`.

## Networks and asset

- **Network:** `paypal:<environment>`, written CAIP-2 style. `paypal:sandbox` is the only one in use; this project never calls PayPal's live API.
- **Asset:** `USD`, 2 decimals. `amount` is a string holding an integer number of US cents (ISO 4217 minor units), with no sign, no decimal point and no leading zero. For example, `"3"` is $0.03. A price below one cent can't be expressed.
- The client declares USD through `findDefaultAsset`, so the SDK's spend controls (`maxAmountPerPayment: "$0.10"`) can compare prices before anything is signed.

## `PaymentRequirements`

A resource server answers an unpaid request with HTTP 402 and a `PAYMENT-REQUIRED` header (base64 JSON, x402 V2). `accepts[]` holds one entry for this scheme:

| Field | Value |
| --- | --- |
| `scheme` | `"prepaid"` |
| `network` | `"paypal:sandbox"` |
| `asset` | `"USD"` |
| `amount` | Price in integer cents as a string, e.g. `"3"` |
| `payTo` | The publisher's BotFare site ID (`site_…`). The ledger credits that site owner's earnings. |
| `maxTimeoutSeconds` | At most 60. `PrepaidPayPalServer.enhancePaymentRequirements` clamps larger values. |
| `extra` | `{}`; no scheme-specific fields are needed. |

A decoded example, as the demo publisher sends it:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4000/articles/burr-basics",
    "description": "Full article (text)",
    "mimeType": "text/html"
  },
  "accepts": [{
    "scheme": "prepaid",
    "network": "paypal:sandbox",
    "amount": "3",
    "asset": "USD",
    "payTo": "site_22a19e75551c4c2c",
    "maxTimeoutSeconds": 60,
    "extra": {}
  }]
}
```

**Preview (BotFare extension).** The 402 body is `{"preview": {"title", "excerpt", "wordCount"?} | null}`, where `excerpt` is at most 600 characters. The publisher middleware sends it as the SDK's `unpaidResponseBody`, and agents read it free before deciding to pay. `getOffer()` in `@botfare/sdk` returns it.

## `PaymentPayload`

The client retries with a `PAYMENT-SIGNATURE` header (base64 JSON, x402 V2):

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:4000/articles/burr-basics", "...": "..." },
  "accepted": { "scheme": "prepaid", "network": "paypal:sandbox", "amount": "3", "asset": "USD", "payTo": "site_22a19e75551c4c2c", "maxTimeoutSeconds": 60, "extra": {} },
  "payload": { "authorization": "<compact JWS>" }
}
```

`payload.authorization` is a compact JWS:

- **Protected header:** `{"alg": "EdDSA", "kid": "<agent key ID, ak_…>", "typ": "x402-prepaid+jwt"}`
- **Claims:**

| Claim | Meaning |
| --- | --- |
| `scheme`, `network`, `asset`, `amount`, `payTo` | Copied from the accepted requirements |
| `nonce` | A random string of at least 16 characters, chosen by the client (`crypto.randomUUID()`) |
| `iat` | Unix seconds when the authorization was signed |
| `exp` | `iat` + lifetime, where lifetime = min(`maxTimeoutSeconds`, 60) |

The key is Ed25519 (JWK `kty: OKP`, `crv: Ed25519`). The private key stays with the agent. In the reference SDK it travels as a single `bfk_…` string: base64url of `{v: 1, keyId, privateJwk}`. BotFare stores only the public JWK and refuses to store any JWK that contains `d`.

## Verification

The facilitator applies these rules in order (`PrepaidPayPalFacilitator.verify`). The first rule that fails sets the `invalidReason`.

1. The requirements use scheme `prepaid`, a `paypal:*` network and asset `USD`, and `amount` is a positive integer cent string.
2. `payload.authorization` is a non-empty string, and its protected header has a `kid`.
3. The key exists and is active.
4. The JWS verifies against the key's public JWK with `alg: EdDSA` and `typ: x402-prepaid+jwt`. `iat` and `exp` must both be present. The token must be unexpired, and it must not be dated in the future or be more than 60 s old; 5 s of clock skew is allowed.
5. The signed `scheme`, `network`, `asset`, `amount` and `payTo` each equal the requirements, and so does each field of `accepted`. `exp − iat` does not exceed the lifetime.
6. Ledger checks, read-only (`PrepaidLedgerPort.check`):
   - the nonce has not been used by this key;
   - `payTo` is a known site, and it is in the key's `allowedSiteIds` if that list is set;
   - `amount` is no more than the key's per-request max;
   - the key's settled spend for the current UTC day plus `amount` is no more than its daily cap (refunded receipts don't count);
   - the payer's wallet holds at least `amount`.

Verify moves no money. When it succeeds it returns `{isValid: true, payer: <key ID>}`.

## Settlement

The resource server settles only after its handler has succeeded, because `PrepaidPayPalServer` declares the `authorization` payment flow. Order is verify → handler → settle, so a failed response (status 400 or above) is never charged.

`settle` runs steps 1 to 5 again. Then, in **one database transaction** (`PostgresPrepaidLedger.charge`), it:

1. locks the agent key row and then the wallet row (`SELECT … FOR UPDATE`), and re-runs every ledger check;
2. posts a balanced ledger transaction with the idempotency key `charge:<keyId>:<nonce>`:

   | Account | Amount (micro-dollars, 1 USD = 1,000,000) |
   | --- | --- |
   | `wallet:<agent owner>` | −amount |
   | `earnings:<site owner>` | +(amount − fee) |
   | `platform:fees` | +fee, where fee = floor(5% of amount) |

3. writes a receipt `rcpt_…` that is unique on (key, nonce).

It returns `{success: true, transaction: "rcpt_…", network, payer: <key ID>, amount}`, and the resource server sends that back to the client as `PAYMENT-RESPONSE`.

**Replay.** A nonce can be used once per key, for good. A reused nonce is refused with `invalid_prepaid_nonce_used`. The refusal carries `extra.originalTransaction`, the receipt the nonce was first charged under, so a client whose settle response was lost can reconcile without paying twice. At the publisher, a replayed `PAYMENT-SIGNATURE` gets a 402 whose `error` is `invalid_prepaid_nonce_used`.

**Ledger invariants.** All entries sum to zero, both overall and within each transaction. Each account's cached balance equals the sum of its entries. A CHECK constraint keeps wallet and earnings balances at zero or above.

## Error codes

These are standard x402 reasons where one fits, and `invalid_prepaid_*` otherwise:

| Reason | When |
| --- | --- |
| `invalid_scheme` | `scheme` is not `prepaid` |
| `invalid_network` | The network is not `paypal:*` (or, at BotFare's API, not `paypal:sandbox`) |
| `invalid_payment_requirements` | The asset is not USD, or `amount` is not a positive integer cent string |
| `invalid_payload` | `payload.authorization` is missing, or the JWS has no `kid` |
| `invalid_prepaid_unknown_key` | No agent key has this `kid` |
| `invalid_prepaid_key_revoked` | The key has been revoked |
| `invalid_prepaid_signature` | The signature does not verify, or the token is malformed |
| `invalid_prepaid_authorization_expired` | `exp` has passed, or `iat` is in the future or more than 60 s old |
| `invalid_prepaid_authorization_mismatch` | A signed field or an `accepted` field differs from the requirements, or the lifetime is above the limit |
| `invalid_prepaid_nonce_used` | The nonce was already charged; `extra.originalTransaction` names the receipt |
| `invalid_prepaid_site_not_allowed` | Unknown `payTo`, a site outside the key's allowed list, or a site at BotFare's API settling for a different `payTo` |
| `invalid_prepaid_over_per_request_max` | `amount` is above the key's per-request max |
| `invalid_prepaid_over_daily_cap` | The payment would take the key over its daily cap |
| `insufficient_funds` | The wallet balance is below `amount` |
| `unexpected_settle_error` | The ledger threw during settle; nothing was charged |

## Facilitator endpoints

The base URL is `${BOTFARE_URL}/api/x402`. All bodies are JSON.

| Endpoint | Auth | Body | Response |
| --- | --- | --- | --- |
| `GET /supported` | none | | `{kinds: [{x402Version: 2, scheme: "prepaid", network: "paypal:sandbox"}], extensions, signers}` |
| `POST /verify` | site | `{x402Version, paymentPayload, paymentRequirements}` | `VerifyResponse` |
| `POST /settle` | site | same as verify | `SettleResponse` |
| `POST /refund` | site | `{transaction: "rcpt_…"}` | `{ok, transaction, status, amountCents, refundTransaction, alreadyRefunded}` |

**Site auth.** Requests carry `Authorization: Basic base64(siteId:siteSecret)`. The secret is 32 random bytes in base64url, shown to the publisher once. BotFare stores only its SHA-256 and compares it in constant time. A missing or wrong secret gets `401 {error: "unauthorized"}` with `WWW-Authenticate: Basic realm="BotFare"`.

**Binding.** A site can verify and settle only payments whose `payTo` is its own site ID. Otherwise the endpoint answers HTTP 200 with an x402 failure (`invalid_prepaid_site_not_allowed`), so the SDK on the publisher's side treats it as an invalid payment rather than a transport error. A malformed body gets 400 `invalid_json` or `invalid_request`. An exception in the facilitator gets 500 `verify_failed` or `settle_failed`.

**Refunds (BotFare extension, not part of the x402 handshake).** A publisher can refund one of its own receipts. The refund posts the charge in reverse (wallet +amount, earnings −(amount − fee), fees −fee) under the idempotency key `refund:<receiptId>` and marks the receipt `refunded`. A repeat call returns `alreadyRefunded: true` and moves nothing. A receipt belonging to another site gets 404 `not_found`. If the publisher's earnings have already been paid out, the call gets 409 `insufficient_earnings`.

**Site config.** `GET ${BOTFARE_URL}/api/sites/<siteId>/config` uses the same site auth and returns the `SiteConfig` (pricing rules, free paths, `chargeKnownBots`, version) that the `botfare()` middleware caches for 30 s.

## Security notes

- The signature covers every field that decides who pays whom and how much. The resource URL is not signed: the price, payee and nonce bind the payment, and `resource.url` is recorded on the receipt only for display.
- Each authorization lives at most 60 s and can be used once. Its nonce is stored for good, which more than covers the 60 s lifetime plus skew.
- Spend limits are checked twice: by the SDK's spend controls before signing (`BotFareSpendLimitError`, so nothing is signed or sent) and by the facilitator inside the settle transaction.
- No personal data travels in headers. The payer is identified only by its agent key ID, and the agent header `x-botfare-agent` carries the constant `1`.

## Precedent

Cloudflare's `batch-settlement` scheme in the x402 repository runs on network `cloudflare:402`, with `asset: "USD"`, amounts in cents and Ed25519-signed agents. `prepaid` on `paypal:*` follows the same pattern: a cents-denominated x402 scheme that settles in an off-chain ledger.
