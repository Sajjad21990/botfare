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
| `extra` | `{"botfareSignal": "<signal>", "botfareOffer": {title, preview, wordCount?}, "botfareResource": "<URL served>"}` from BotFare's middleware (see below); the scheme itself needs no fields. |

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
    "extra": {
      "botfareSignal": "signed-agent",
      "botfareOffer": {
        "title": "Burr grinders, explained",
        "preview": "Ask ten people what upgrade made the biggest difference to…",
        "wordCount": 835
      },
      "botfareResource": "http://localhost:4000/articles/burr-basics"
    }
  }]
}
```

**Detection signal (BotFare extension).** `extra.botfareSignal` says why the publisher asked this request to pay. It is one of `signed-agent`, `agent-header`, `known-bot`, `bot-impostor`, `edge-score`, `automation`, `payment-signature` or `everyone` (`detectionSignalSchema` in `@botfare/contracts`). The resource server (a `PrepaidPayPalServer` subclass in `@botfare/express`, `src/payment-gate.ts`) declares it in `dynamicExtraFields`, so `@x402/core` leaves it out when it matches a payment's `accepted` terms: a client that echoes a different signal still matches, and verify and settle always receive the server's own value. The facilitator passes `requirements.extra` to the ledger, which stores a known signal on the receipt (`receipts.detection_signal`; an unknown or missing one is stored as null). The signal decides nothing about money; it feeds "revenue by detection signal" in the publisher's analytics.

**Served resource (BotFare extension, signed receipts).** `extra.botfareResource` is the URL the publisher's server is serving, built exactly as `@x402/express` builds the 402's `resource.url` (`req.protocol`, the `Host` header, `req.originalUrl`; `botfare()` also sets the route's `resource` to the same string). It is a dynamic extra field too, so verify and settle receive the server's value whatever a client echoes. The facilitator records this URL on the receipt (`serverResourceUrl` in `@botfare/x402-paypal`: http(s) only, at most 2,048 characters), and BotFare signs it as a payment statement's `resource`. The client's `PaymentPayload.resource.url` is never used: the agent writes it and its signature does not cover it. A resource server that does not send the field gets receipts with no URL (`resource: null`).

**Declared offer (BotFare extension, Fare Court).** `extra.botfareOffer` is what the publisher promises for the price: `{title (1–200 chars), preview (≤ 600 chars), wordCount?}` (`declaredOfferSchema` in `@botfare/contracts/fare`). `botfare()` builds it from the site's `preview(req)` option, or from the pricing rule's description when there is no preview. Like the signal it is a dynamic extra field: the server always settles with its own declaration, whatever a client echoes. Settle stores it on the receipt (`receipts.declared_offer`; a missing or invalid one is stored as null), and Fare Court compares it with what was delivered.

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

It returns `{success: true, transaction: "rcpt_…", network, payer: <key ID>, amount, extra: {botfareReceipt: "<signed payment statement>"}}`, and the resource server sends that back to the client as `PAYMENT-RESPONSE`. The official SDK carries `extra` through unchanged (`HTTPFacilitatorClient` → `x402ResourceServer.settlePayment` → `encodePaymentResponseHeader`), so any x402 client finds the statement there; see [Signed receipts](#signed-receipts). `extra` is absent if signing is disabled or failed; the payment is settled either way.

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
| `POST /receipts/<receiptId>/attest` | site | `{contentDigest, contentLength, contentType, status}` | `{ok, receiptId, contentDigest, alreadyAttested}` ([proof of delivery](#fare-court-proof-of-delivery-and-disputes)) |
| `POST /telemetry` | site | `{events: [{path, method, priceCents, signal, at}]}`, 1 to 500 events | `{ok, accepted, dropped}` ([offer telemetry](#fare-advisor-signals)) |

**Site auth.** Requests carry `Authorization: Basic base64(siteId:siteSecret)`. The secret is 32 random bytes in base64url, shown to the publisher once. BotFare stores only its SHA-256 and compares it in constant time. A missing or wrong secret gets `401 {error: "unauthorized"}` with `WWW-Authenticate: Basic realm="BotFare"`.

**Binding.** A site can verify and settle only payments whose `payTo` is its own site ID. Otherwise the endpoint answers HTTP 200 with an x402 failure (`invalid_prepaid_site_not_allowed`), so the SDK on the publisher's side treats it as an invalid payment rather than a transport error. A malformed body gets 400 `invalid_json` or `invalid_request`. An exception in the facilitator gets 500 `verify_failed` or `settle_failed`.

**Refunds (BotFare extension, not part of the x402 handshake).** A publisher can refund one of its own receipts. The refund posts the charge in reverse (wallet +amount, earnings −(amount − fee), fees −fee) under the idempotency key `refund:<receiptId>` and marks the receipt `refunded`. A repeat call returns `alreadyRefunded: true` and moves nothing. A receipt belonging to another site gets 404 `not_found`. If the publisher's earnings have already been paid out, the call gets 409 `insufficient_earnings`.

**Site config.** `GET ${BOTFARE_URL}/api/sites/<siteId>/config` uses the same site auth and returns the `SiteConfig` (pricing rules, free paths, `chargeKnownBots`, version) that the `botfare()` middleware caches for 30 s. A price the publisher applies from the Fare Advisor changes `version` and reaches the middleware within those 30 s.

## Signed agents (Web Bot Auth)

Agents identify themselves cryptographically before any payment, with RFC 9421 HTTP Message Signatures over Ed25519, in the Web Bot Auth format that Cloudflare verifies. The BotFare SDK signs every request it sends (the offer read, the unpaid request and the paid retry), each with a fresh `created` and `nonce`. The signer (`createRequestSigner`) and the verifier (`verifySignedRequest`) are one module, `@botfare/contracts/web-bot-auth`, which the SDK and the `botfare()` middleware both import.

```
Signature-Agent: "https://botfare.example"
Signature-Input: sig1=("@authority" "signature-agent");created=1762600000;keyid="<JWK thumbprint>";alg="ed25519";expires=1762600060;nonce="<64 random bytes, base64url>";tag="web-bot-auth"
Signature: sig1=:<base64 Ed25519 signature>:
```

- **`keyid`** is the RFC 7638 / RFC 8037 SHA-256 thumbprint (base64url) of the agent key's public JWK: the same Ed25519 key that signs payment authorizations.
- **Signature base** (RFC 9421 section 2.5), lines joined by `\n`: `"@authority": <host[:port]>`, `"signature-agent": "<origin>"`, then `"@signature-params": <the inner list>`. `Signature-Agent` is the origin of `BOTFARE_URL`, as an sf-string; the verifier also accepts the newer dictionary form covered as `"signature-agent";key="…"`.
- **Key directory.** BotFare publishes every active agent key at `${BOTFARE_URL}/.well-known/http-message-signatures-directory` (`application/http-message-signatures-directory+json`, `Cache-Control: max-age=60`) as `{keys: [{kty: "OKP", crv: "Ed25519", x, kid: <thumbprint>, use: "sig", botfare_key_id: "ak_…"}]}`. A revoked key leaves the directory. `GET /api/agents/<thumbprint>` returns `{keyId, status}`.
- **Publisher rules** (`botfare()`): keys come only from the publisher's own configured BotFare URL, never from the URL a request names. The member tagged `web-bot-auth` is used, whatever its label. `created` and `expires` are required; `created` may be at most 5 s in the future, the signature is refused after `expires`, and it may live at most 24 h (the SDK uses 60 s). `@authority` (or `@target-uri`) must be covered, and so must `signature-agent` when it is sent. Behind a proxy, `X-Forwarded-Host` is tried as the authority too. The directory is cached for 5 minutes; an unknown `keyid` refreshes it at most every 30 s.
- **Failure is never punished.** An expired, unknown or tampered signature is ignored and the request is scored as if unsigned. A valid one is the `signed-agent` signal, which charges at every detection level.
- **Not done:** the directory response itself is not signed (the draft asks for one signature per listed key, made with that key's private key, which BotFare does not hold).

## Agent API (signed requests, no tokens)

Besides paying publishers, an agent can ask BotFare about its own budget, dispute a purchase, and leave signals for publishers. The MCP server's `wallet_balance`, `recent_receipts`, `dispute_purchase` and `decline_offer` tools and the SDK's `dispute()`, `decline()` and `reportCitations()` use these endpoints ([`packages/mcp/README.md`](../packages/mcp/README.md)).

| Endpoint | Response |
| --- | --- |
| `POST ${BOTFARE_URL}/api/disputes` | Body `{receiptId, reason, note?, contentBase64}`; answers a `DisputeOutcome` ([Fare Court](#fare-court-proof-of-delivery-and-disputes)) |
| `POST ${BOTFARE_URL}/api/offers/decline` | Body `{url, priceCents, category, reason}`; `{ok, recorded, path}` ([signals](#fare-advisor-signals)) |
| `POST ${BOTFARE_URL}/api/citations` | Body `{answerId, citations: [{receiptId, claim?}]}`; `{ok, recorded, rejected}` |
| `GET ${BOTFARE_URL}/api/agent/wallet` | `{keyId, keyName, balanceUsd, spentTodayUsd, dailyCapUsd, perRequestMaxUsd, allowedSiteIds}`; `balanceUsd` is the owner's wallet, `spentTodayUsd` this key's settled spend in the current UTC day; `null` limits mean none |
| `GET ${BOTFARE_URL}/api/agent/receipts?limit=N` | `{keyId, receipts: [{receiptId, time, site, siteId, url, amountUsd, status}]}`, newest first; `limit` 1 to 100, default 10 |

**Auth.** There is no API token or session. Each request carries the same Web Bot Auth signature the SDK puts on every request (`Signature-Agent`, `Signature-Input`, `Signature`, RFC 9421 over Ed25519, signed with the agent key), and BotFare checks it like this:

- The `keyid` (JWK thumbprint) must name an **active** agent key in BotFare's database. The `Signature-Agent` URL is never fetched or trusted.
- The covered `@authority` must be **BotFare's own host**: the host of `BOTFARE_URL` (or `RENDER_EXTERNAL_URL`), or the request's `Host` when neither is set (local development). A signature an agent sent to a publisher therefore cannot be replayed against BotFare.
- `created` and `expires` are required; the signature may live at most 5 minutes, with 30 s of clock skew.
- Each `nonce` is accepted once while its signature is valid (in memory, per app instance).

A missing, expired, reused or foreign signature, or a revoked or unknown key, gets `401 {error: "unauthorized", message}` with `WWW-Authenticate: Signature realm="botfare-agent-api"` and `Cache-Control: no-store`; the message says which check failed. The wallet and receipts endpoints only read. A dispute is the one call that can move money, and only back to the agent's owner: a refund decided by Fare Court's policy in code (below), never by the agent. Decline notes and citations move nothing.

## Fare Court: proof of delivery and disputes

BotFare extension: buyer protection for purchases too small for a person to dispute. The contracts are in `@botfare/contracts/fare`; policy lives in `@botfare/core` (`openDispute`, `applyVerdict`, `publisherDecide`).

**Content digest.** `contentDigestSha256(body)` is RFC 9530's `Content-Digest` value for SHA-256 over the exact bytes delivered: `sha-256=:<base64 of the 32-byte hash>:` (e.g. `sha-256=:+oWVrNYqTwN…=:`). For a paid response, `botfare()` hashes the body bytes as they pass through `res.write`/`res.end` (installed before `@x402/express` buffers the response, so the hash covers exactly what is replayed to the agent after settle). Mount `compression()` before `botfare()`: the digest is over the decoded body an agent's `fetch` sees.

**Attestation.** After the response is finished, and only for status < 400 (a redirect included: x402 settles it like any success, and the SDK returns that 3xx with its receipt instead of following it) with a successful `PAYMENT-RESPONSE`, the middleware posts to `POST /api/x402/receipts/<receiptId>/attest` (site auth) the `ReceiptAttestation` `{contentDigest, contentLength, contentType, status}`. It never delays the response; it retries after 0.5, 2 and 5 s on 5xx, 408, 429 or a network error. BotFare stores only the media type of `contentType` (`text/html; charset=utf-8` becomes `text/html`; a value that is not a type/subtype is stored as unknown). Only the site that was paid may attest, and the first attestation wins: 200 for the first and for an identical repeat (`alreadyAttested: true`), 409 for a different digest, 404 for another site's receipt, 400 for an invalid body.

**Dispute.** `POST /api/disputes`, signed with the agent key (Web Bot Auth, as above):

```json
{ "receiptId": "rcpt_…", "reason": "stub_or_paywall", "note": "Got a subscribe wall", "contentBase64": "<the exact bytes received>" }
```

`reason` is one of `not_as_described`, `stub_or_paywall`, `error_page`, `truncated`, `unrelated`, `other`; `note` is at most 500 characters; the content is at most 1,000,000 bytes before base64. BotFare checks, in order: the receipt belongs to this agent key and is still settled; no other dispute on it is open or decided; the key's daily limit (10 per UTC day; invalid disputes count); the 24-hour window; a publisher attestation exists; and the content hashes to the attested digest. A late dispute or a digest mismatch is stored with status `invalid` (after a mismatch the agent may file again with the right bytes).

**Verdict and policy.** The AI judge (Claude, structured output) receives the declared offer, the agent's reason and note, and up to 12,000 characters of the delivered text, all as untrusted data, and returns a `DisputeVerdict` `{decision: refund | deny | unsure, confidence 0–1, category, rationale, evidence[]}`, validated with zod (one retry, then `unsure`). An empty body, under 20 characters of text, or a delivered status of 400 or above skips the judge. Then `DISPUTE_POLICY` decides:

| Verdict | Outcome `status` |
| --- | --- |
| `refund`, confidence ≥ 0.8, key within the dispute-rate rule | `refunded`: the ledger's refund for the receipt (idempotency key `refund:<receiptId>`, so one refund per receipt ever) |
| `deny`, confidence ≥ 0.8 | `denied` |
| anything else, no verdict (no `ANTHROPIC_API_KEY`, model error, budget), or a refund the publisher's paid-out earnings cannot cover | `pending_publisher`: the publisher accepts (`refunded`) or declines (`rejected_by_publisher`) on the Disputes page or `POST /api/publisher/disputes {disputeId, decision}` |

The dispute-rate rule: once a key has 10 or more purchases in 7 days, a confident refund verdict refunds automatically only while (its valid disputes in 7 days + 1) / purchases ≤ 0.2. The shared demo research key (the server's `BOTFARE_AGENT_KEY`, owned by a demo persona) has 200 disputes a day and no rate rule, because every judge's run uses it.

**Answer.** `DisputeOutcome` `{disputeId, receiptId, status, refundedCents, verdict, message}` whenever a dispute row exists: 200 for a new dispute, 422 for an `invalid` one, 409 when one was already open or decided. Other refusals answer `{error, reason, message}`: 400 invalid body, 401 bad signature, 404 not this key's receipt, 409 `already_refunded` or `not_attested`, 413 content too large, 429 daily limit. The SDK re-files a `not_attested` dispute after 1 s and 2 s, freshly signed, since the attestation is sent just after the response.

## Fare Advisor signals

BotFare extension: what agents did with an offer, so publishers can price for AI readers. No personal data: no IP addresses or user agents are stored, and telemetry drops query strings.

- **Offers shown** (`POST /api/x402/telemetry`, site auth). `botfare()` counts each 402 that carries a price as `{path (no query string), method, priceCents, signal, at}` and sends batches every 15 s or at 200 events (at most 2,000 waiting, oldest dropped first; fire and forget). BotFare drops events stamped more than 5 minutes ahead or older than 2 days, and events with a control character in the path or method (each on its own; the rest of the batch is kept), and stores at most 20,000 events per publisher (all their sites) per UTC day. Best effort by design: the counts are a floor.
- **Decline notes** (`POST /api/offers/decline`, signed). `{url, priceCents, category, reason}`, where `category` is `too_expensive`, `irrelevant`, `low_quality_preview`, `already_have`, `over_budget` or `other`, and `reason` is one sentence (≤ 300 characters). The URL must be on a registered site's origin (422 otherwise), and `priceCents` must be what one of that site's pricing rules for the path charges now (400 otherwise). One note per key, path (the query string is dropped) and UTC day is kept, and at most three per agent owner, path and day across all the owner's keys (`recorded: false` past either), at most 500 per key per day.
- **Citations** (`POST /api/citations`, signed). `{answerId (8–64 chars), citations: [{receiptId, claim?}]}`, 1 to 20 per report. Only receipts paid by the key owner count (others come back in `rejected`); a report with the same `answerId` replaces the earlier one.

The publisher reads these per pricing rule and per path at `GET /api/publisher/advisor?siteId=…` (session): offers, paid, declined, cited and disputed with the top reasons, each counted at the rule's current price only (signals at an earlier price are in the rule's `earlier`, and a rule nobody has seen at its new price has `awaitingSignals: true` and gets no AI recommendation), plus Claude's recommendations when `ANTHROPIC_API_KEY` is set (`aiAvailable: false` otherwise). Applying one is a separate, explicit `POST /api/publisher/advisor/apply {siteId, pattern, priceCents?, audience?}`.

## Signed receipts

BotFare extension: statements BotFare signs when something happens to a receipt, so anyone can check a payment, a delivery or a refund with BotFare's public keys alone, without asking BotFare's database. Schemas, constants and the verifier are in `@botfare/contracts/receipts` (Node and browsers: `jose` + WebCrypto).

**Format.** A compact JWS (RFC 7515), `alg: EdDSA` (Ed25519, RFC 8037), protected header `{alg, typ: "botfare-receipt+jwt", kid}`. Claims common to every statement:

| Claim | Meaning |
| --- | --- |
| `iss` | BotFare's origin (`BOTFARE_URL`), e.g. `https://botfare-web.onrender.com` |
| `sub` | The receipt ID, `rcpt_…` |
| `iat` | Signing time (seconds) |
| `v` | Format version, `1` |
| `kind` | `payment`, `delivery` or `refund`, with the matching object below |

- `payment` (signed at settle): `{scheme: "prepaid", network, asset: "USD", amount (integer cents, as in the requirements), amountMicros, publisherMicros, feeMicros, payTo (site_…), siteOrigin, resource (the URL the paid site's server said it was serving, from `extra.botfareResource`; null if it sent none), payer (ak_…), payerThumbprint (RFC 7638 of the agent's public key), signal (detection signal or null), offerDigest, settledAt}`. `offerDigest` is `contentDigestSha256(canonicalJson(declaredOffer))`, where `declaredOffer` is the 402's `extra.botfareOffer` and `canonicalJson` sorts object keys at every level with no whitespace (JCS for this shape); both are exported by the contract. Null when no offer was declared.
- `delivery` (signed when the paid site first attests, see [Fare Court](#fare-court-proof-of-delivery-and-disputes)): `{contentDigest (RFC 9530 sha-256), contentLength, contentType (media type), status, attestedAt}`.
- `refund` (signed when the receipt is refunded): `{refundedMicros, via: "publisher" | "dispute", disputeId, refundedAt}`.

Statements do not expire: they record what happened when it happened. The first statement of each kind for a receipt is stored and returned forever; history is never re-signed, not even after a key rotation.

**Where they travel.**

- The payment statement is in the settle response's `extra.botfareReceipt` (`SETTLE_EXTRA_RECEIPT_KEY`), so the agent receives it in the base64 `PAYMENT-RESPONSE` header of the paid response: `decodePaymentResponseHeader(header).extra.botfareReceipt`. The SDK exposes it as `PaidResult.receiptStatement`.
- `GET /api/receipts/<receiptId>/statements` (`receiptStatementsPath`) returns `{receiptId, payment, delivery, refund}`, each a JWS or null. Public, `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`, 120 lookups per minute per client IP (429 with `Retry-After: 60`; the IP comes from `True-Client-IP` or the last `X-Forwarded-For` hop, never an entry the client sent, and the limiter keeps at most 10,000 addresses), 404 for an unknown or malformed ID. A statement the receipt qualifies for but that was never stored (a signing failure) is issued on this read. Only pseudonymous IDs appear (receipt, site, agent key); no email, IP address or user agent.

**Keys.** `GET /.well-known/botfare-receipt-keys.json` (`RECEIPT_KEYS_PATH`) is a JWKS (RFC 7517), `Content-Type: application/jwk-set+json`, `Cache-Control: public, max-age=300`, CORS-open. Each key is `{kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig"}`; `kid` is the RFC 7638 thumbprint, and no private member (`d`) is ever published (`publicJwk`). The active key comes first, then retired keys. The signing key is derived on the server: 32-byte seed = HKDF-SHA256(`BOTFARE_RECEIPT_KEY_SEED`, empty salt, info `botfare-receipt-key-v1`). Retired seeds in `BOTFARE_RECEIPT_KEY_SEED_PREVIOUS` stay published but never sign. In production (`NODE_ENV=production` or on Render) without a seed of at least 32 characters, nothing is signed (payments still settle) and the JWKS is empty; in development a public development seed signs, which proves nothing.

**Verifying.** `verifyStatement(token, jwks, {issuer?, kind?})` checks the header (`typ`, `kid`), the Ed25519 signature against the key with that `kid`, the claims against the schema, and optionally `iss` and `kind`. It never throws; failures are `malformed`, `unknown_key`, `bad_signature`, `wrong_issuer` or `invalid_claims`. A verifier should also check that `sub` is the receipt it expects. The SDK's `agent.verifyReceipt` caches the JWKS for 10 minutes and refetches it on an unknown `kid` (a rotation), at most every 30 s.

**Sources manifest.** The research agent's answer carries `AnswerManifest` `{answerId, createdAt, sources: [{url, receiptId, claim, payment, delivery, readDigest, refund?}]}`, where `readDigest` is the `Content-Digest` of the bytes the agent actually read. `checkAnswerSource(source, jwks, {issuer})` returns three checks: **paid** (a valid payment statement for this receipt whose signed `resource` equals the cited URL; a statement with `resource: null` is "not bound to a URL" and does not count), **delivered** (a valid delivery statement for the same receipt) and **bytes match** (`readDigest` equals the signed `contentDigest`). When the source carries a valid refund statement for the receipt, `refund.refunded` is true and **paid** fails ("Fare refunded after a dispute" or "by the publisher"); the Verify sources panel fetches the latest statements for every source, so a refund after the answer was written is seen too.

**What it proves.** A valid statement proves BotFare issued it and cannot later deny it. It does not prove that BotFare never dropped or changed a receipt nobody holds a statement for; a tamper-evident log (signed Merkle checkpoints over all receipts) would, and is future work.

## Security notes

- The agent's signature covers every field that decides who pays whom and how much. It does not cover the client's `resource.url`, so BotFare never uses that field: the receipt and the signed payment statement carry the URL the publisher's server declared in `extra.botfareResource`, sent to the facilitator by the site-authenticated resource server. That URL is the publisher's claim about its own response, like the delivery digest; BotFare does not require it to share the site's registered origin.
- Each authorization lives at most 60 s and can be used once. Its nonce is stored for good, which more than covers the 60 s lifetime plus skew.
- Spend limits are checked twice: by the SDK's spend controls before signing (`BotFareSpendLimitError`, so nothing is signed or sent) and by the facilitator inside the settle transaction.
- A signed-agent signature proves which BotFare key sent a request, not that it will pay: the payment is still the separate `prepaid` authorization above.
- No personal data travels in headers. The payer is identified only by its agent key ID, and the agent header `x-botfare-agent` carries the constant `1`.
- Receipt-signing private keys are never stored or sent: each process derives them in memory from the secret seed `BOTFARE_RECEIPT_KEY_SEED`. The processes that hold the seed are the ones that settle, attest or refund: the web app, `pnpm seed:traffic` (run by hand and by the `botfare-demo-refresh` cron on Render, which shares the web service's generated seed) and the judge Docker stack's setup container. The database stores only signed statements and the `kid` that signed them.

## Precedent

Cloudflare's `batch-settlement` scheme in the x402 repository runs on network `cloudflare:402`, with `asset: "USD"`, amounts in cents and Ed25519-signed agents. `prepaid` on `paypal:*` follows the same pattern: a cents-denominated x402 scheme that settles in an off-chain ledger.
