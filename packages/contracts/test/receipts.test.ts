import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  SignJWT,
} from "jose";
import { describe, expect, it } from "vitest";
import { contentDigestSha256 } from "../src/fare";
import {
  canonicalJson,
  checkAnswerSource,
  declaredOfferDigest,
  decodeStatement,
  publicJwk,
  RECEIPT_JWT_TYPE,
  verifyStatement,
} from "../src/receipts";

const ISSUER = "https://botfare.example";

async function signer() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const pub = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(pub);
  const priv: JWK = { ...(await exportJWK(privateKey)), kid };
  const sign = async (claims: Record<string, unknown>, typ = RECEIPT_JWT_TYPE) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid, typ })
      .sign(await importJWK(priv, "EdDSA"));
  return { jwks: { keys: [publicJwk({ ...pub, kid, alg: "EdDSA", use: "sig" })] }, kid, sign };
}

const payment = (receiptId = "rcpt_1", resource = "https://demo.example/articles/a") => ({
  iss: ISSUER,
  sub: receiptId,
  iat: 1_794_000_000,
  v: 1,
  kind: "payment",
  payment: {
    scheme: "prepaid",
    network: "paypal:sandbox",
    asset: "USD",
    amount: "3",
    amountMicros: 30_000,
    publisherMicros: 28_500,
    feeMicros: 1_500,
    payTo: "site_1",
    siteOrigin: "https://demo.example",
    resource,
    payer: "ak_1",
    payerThumbprint: null,
    signal: "signed-agent",
    offerDigest: null,
    settledAt: "2026-11-09T10:00:00.000Z",
  },
});

describe("signed receipts", () => {
  it("verifies a payment statement and rejects tampering, wrong keys and wrong issuers", async () => {
    const { jwks, kid, sign } = await signer();
    const token = await sign(payment());
    const ok = await verifyStatement(token, jwks, { issuer: ISSUER, kind: "payment" });
    expect(ok.ok && ok.kid === kid && ok.statement.kind === "payment").toBe(true);

    const [h, , s] = token.split(".");
    const forged = `${h}.${btoa(
      JSON.stringify({ ...payment(), payment: { ...payment().payment, amountMicros: 1 } }),
    )
      .replaceAll("=", "")
      .replaceAll("+", "-")
      .replaceAll("/", "_")}.${s}`;
    expect((await verifyStatement(forged, jwks)).ok).toBe(false);

    const other = await signer();
    const wrongKey = await verifyStatement(token, other.jwks);
    expect(wrongKey.ok ? "" : wrongKey.error).toBe("unknown_key");

    const wrongIssuer = await verifyStatement(token, jwks, { issuer: "https://evil.example" });
    expect(wrongIssuer.ok ? "" : wrongIssuer.error).toBe("wrong_issuer");

    const notOurs = await sign(payment(), "JWT");
    expect((await verifyStatement(notOurs, jwks)).ok).toBe(false);
    expect(decodeStatement(token)?.sub).toBe("rcpt_1");
  });

  it("never publishes the private part of a key", async () => {
    const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(privateKey);
    expect(jwk.d).toBeDefined();
    expect(publicJwk(jwk).d).toBeUndefined();
  });

  it("checks a cited source end to end: paid, delivered, bytes match", async () => {
    const { jwks, sign } = await signer();
    const body = "<h1>Burr grinders, explained</h1>";
    const digest = await contentDigestSha256(body);
    const delivery = await sign({
      iss: ISSUER,
      sub: "rcpt_1",
      iat: 1_794_000_001,
      v: 1,
      kind: "delivery",
      delivery: {
        contentDigest: digest,
        contentLength: body.length,
        contentType: "text/html",
        status: 200,
        attestedAt: "2026-11-09T10:00:01.000Z",
      },
    });
    const source = {
      url: "https://demo.example/articles/a",
      receiptId: "rcpt_1",
      claim: "",
      payment: await sign(payment()),
      delivery,
      readDigest: digest,
    };
    const good = await checkAnswerSource(source, jwks, { issuer: ISSUER });
    expect([good.paid.ok, good.delivered.ok, good.bytesMatch.ok]).toEqual([true, true, true]);

    const otherBytes = await checkAnswerSource(
      { ...source, readDigest: await contentDigestSha256("other") },
      jwks,
    );
    expect(otherBytes.bytesMatch.ok).toBe(false);

    const otherUrl = await checkAnswerSource(
      { ...source, url: "https://demo.example/articles/b" },
      jwks,
    );
    expect(otherUrl.paid.ok).toBe(false);

    const swapped = await checkAnswerSource({ ...source, receiptId: "rcpt_2" }, jwks);
    expect([swapped.paid.ok, swapped.delivered.ok]).toEqual([false, false]);
  });
});

describe("offerDigest", () => {
  it("hashes the declared offer's JSON with keys sorted at every level", async () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [2, { f: 1, e: 0 }] }, z: undefined })).toBe(
      '{"a":{"c":[2,{"e":0,"f":1}],"d":"x"},"b":1}',
    );
    const offer = { title: "Burr basics", preview: "Grind size first.", wordCount: 900 };
    const reordered = { wordCount: 900, preview: "Grind size first.", title: "Burr basics" };
    expect(await declaredOfferDigest(offer)).toBe(await declaredOfferDigest(reordered));
    expect(await declaredOfferDigest(offer)).toBe(
      await contentDigestSha256(
        '{"preview":"Grind size first.","title":"Burr basics","wordCount":900}',
      ),
    );
  });
});
