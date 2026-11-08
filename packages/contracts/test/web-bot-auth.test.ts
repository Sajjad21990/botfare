import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDirectoryKeyResolver,
  createRequestSigner,
  directoryUrlFor,
  type Ed25519PrivateJwk,
  type Ed25519PublicJwk,
  jwkThumbprint,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  signatureAgentHeader,
  verifySignedRequest,
} from "../src/web-bot-auth";

// RFC 9421 Appendix B.1.4 test-key-ed25519, which the Web Bot Auth draft's vectors use.
const PRIVATE_PEM_BODY = "MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF";
const TEST_X = "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs";
const TEST_KID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const TEST_PUBLIC: Ed25519PublicJwk = { kty: "OKP", crv: "Ed25519", x: TEST_X };
const TEST_PRIVATE: Ed25519PrivateJwk = {
  ...TEST_PUBLIC,
  // The PKCS#8 body ends with the 32-byte seed.
  d: base64Url(Uint8Array.from(atob(PRIVATE_PEM_BODY), (c) => c.charCodeAt(0)).slice(-32)),
};

const resolveTestKey = (keyid: string) => (keyid === TEST_KID ? TEST_PUBLIC : null);
const VECTOR_NOW = 1735689700;

/** Draft-meunier-web-bot-auth-architecture-05, Appendix A.2 (EdDSA). Headers unwrapped per RFC 8792. */
const VECTORS = {
  "A.2.1 no Signature-Agent": {
    "signature-input":
      'sig1=("@authority");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="g0iqFa9e1ffijlyOScDkXpfSmTbYpRNSGPJrQ1It20ahwgzB3jOUcdgLgFxUg7RMtW4V8IILaKKtA+YuSyIgJQ==";tag="web-bot-auth"',
    signature:
      "sig1=:FFASViSdcgsyaqqYiCnkHreeZzbNKcTzDvZC5uVlP/dn9IbWj8j0o4wKFTH3rBnUiSUBduwm1Gp5VlIPCp01Ag==:",
  },
  "A.2.3 legacy Signature-Agent": {
    "signature-agent": '"https://signature-agent.test"',
    "signature-input":
      'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"',
    signature:
      "sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:",
  },
};

describe("web bot auth: draft test vectors", () => {
  it("computes the RFC 8037 thumbprint of the test key", async () => {
    expect(await jwkThumbprint(TEST_PUBLIC)).toBe(TEST_KID);
  });

  for (const [name, headers] of Object.entries(VECTORS)) {
    it(`verifies ${name}`, async () => {
      const result = await verifySignedRequest({
        url: "https://example.com/",
        headers,
        resolveKey: resolveTestKey,
        now: VECTOR_NOW,
        maxValiditySeconds: 4889289600,
      });
      expect(result).toMatchObject({ ok: true, keyid: TEST_KID });
      if (result.ok && "signature-agent" in headers) {
        expect(result.signatureAgent).toBe("https://signature-agent.test");
        expect(result.directoryUrl).toBe(
          "https://signature-agent.test/.well-known/http-message-signatures-directory",
        );
      }
    });
  }

  // The draft's A.2.2 Signature does not match its own printed signature base (checked with
  // node:crypto), so the dictionary form is checked by signing that printed base independently.
  it("verifies A.2.2 dictionary Signature-Agent, signed over the draft's printed base", async () => {
    const params =
      '("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg==";tag="web-bot-auth"';
    const base = `"@authority": example.com\n"signature-agent";key="agent2": "https://signature-agent.test"\n"@signature-params": ${params}`;
    const key = createPrivateKey(
      `-----BEGIN PRIVATE KEY-----\n${PRIVATE_PEM_BODY}\n-----END PRIVATE KEY-----\n`,
    );
    const signature = nodeSign(null, new TextEncoder().encode(base), key);
    const result = await verifySignedRequest({
      url: "https://example.com/",
      headers: {
        "signature-agent": 'agent2="https://signature-agent.test"',
        "signature-input": `sig2=${params}`,
        signature: `sig2=:${btoa(String.fromCharCode(...signature))}:`,
      },
      resolveKey: resolveTestKey,
      now: VECTOR_NOW,
      maxValiditySeconds: 4889289600,
    });
    expect(result).toMatchObject({ ok: true, signatureAgent: "https://signature-agent.test" });
  });

  it("reproduces vector A.2.3 byte for byte (Ed25519 is deterministic)", async () => {
    const signer = createRequestSigner({
      privateJwk: TEST_PRIVATE,
      signatureAgent: "https://signature-agent.test",
      ttlSeconds: 3600,
      label: "sig2",
      nonce:
        "e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==",
      now: () => 1735689600,
    });
    const signed = await signer.sign({ url: "https://example.com/" });
    expect(signed).toEqual(VECTORS["A.2.3 legacy Signature-Agent"]);
  });
});

describe("web bot auth: BotFare signing", () => {
  async function newKey() {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Ed25519PrivateJwk;
    const privateJwk: Ed25519PrivateJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d };
    const publicJwk: Ed25519PublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
    return { privateJwk, publicJwk, kid: await jwkThumbprint(publicJwk) };
  }

  it("signs @authority and Signature-Agent with a 60 s window", async () => {
    const key = await newKey();
    const signed = await createRequestSigner({
      privateJwk: key.privateJwk,
      signatureAgent: "https://botfare.example/some/path",
      now: () => 1_800_000_000,
    }).sign({ url: "https://crema.example/articles/one?x=1" });

    expect(signed["signature-agent"]).toBe('"https://botfare.example"');
    expect(signed["signature-input"]).toMatch(
      new RegExp(
        `^sig1=\\("@authority" "signature-agent"\\);created=1800000000;keyid="${key.kid}";alg="ed25519";expires=1800000060;nonce="[A-Za-z0-9_-]{86}";tag="web-bot-auth"$`,
      ),
    );
    expect(signed.signature).toMatch(/^sig1=:[A-Za-z0-9+/]{86}==:$/);

    const result = await verifySignedRequest({
      authority: "crema.example",
      headers: signed,
      resolveKey: (keyid) => (keyid === key.kid ? key.publicJwk : null),
      now: 1_800_000_030,
    });
    expect(result).toMatchObject({ ok: true, keyid: key.kid, label: "sig1" });
  });

  it("omits Signature-Agent without a directory URL and still verifies", async () => {
    const key = await newKey();
    const signed = await createRequestSigner({ privateJwk: key.privateJwk }).sign({
      url: "http://127.0.0.1:4100/x",
    });
    expect(signed["signature-agent"]).toBeUndefined();
    expect(signed["signature-input"]).toContain('sig1=("@authority");');
    const result = await verifySignedRequest({
      url: "http://127.0.0.1:4100/x",
      headers: signed,
      resolveKey: () => key.publicJwk,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects tampering, expiry, unknown keys and missing coverage", async () => {
    const key = await newKey();
    const resolveKey = (keyid: string) => (keyid === key.kid ? key.publicJwk : null);
    const signed = await createRequestSigner({
      privateJwk: key.privateJwk,
      signatureAgent: "https://botfare.example",
      now: () => 1_800_000_000,
    }).sign({ url: "https://crema.example/a" });
    const verify = (extra: Partial<Parameters<typeof verifySignedRequest>[0]>) =>
      verifySignedRequest({
        authority: "crema.example",
        headers: signed,
        resolveKey,
        now: 1_800_000_010,
        ...extra,
      });

    expect((await verify({})).ok).toBe(true);
    expect(await verify({ authority: "evil.example" })).toMatchObject({ reason: "bad-signature" });
    expect(
      await verify({ headers: { ...signed, "signature-agent": '"https://other.example"' } }),
    ).toMatchObject({ reason: "bad-signature" });
    expect(await verify({ now: 1_800_000_061 })).toMatchObject({ reason: "expired" });
    expect(await verify({ now: 1_799_999_900 })).toMatchObject({ reason: "not-yet-valid" });
    expect(await verify({ resolveKey: () => null })).toMatchObject({ reason: "unknown-key" });
    const other = await newKey();
    expect(await verify({ resolveKey: () => other.publicJwk })).toMatchObject({
      reason: "unknown-key",
    });
    expect(await verify({ headers: {} })).toMatchObject({ reason: "missing" });
    expect(await verify({ headers: { signature: signed.signature } })).toMatchObject({
      reason: "malformed",
    });
    expect(
      await verify({
        headers: {
          ...signed,
          "signature-input": signed["signature-input"].replace("web-bot-auth", "other"),
        },
      }),
    ).toMatchObject({ reason: "wrong-tag" });
    // Signature-Agent sent but not covered.
    const bare = await createRequestSigner({
      privateJwk: key.privateJwk,
      now: () => 1_800_000_000,
    }).sign({ url: "https://crema.example/a" });
    expect(
      await verify({ headers: { ...bare, "signature-agent": '"https://botfare.example"' } }),
    ).toMatchObject({ reason: "missing-component" });
  });

  it("rejects windows longer than the verifier allows", async () => {
    const key = await newKey();
    const signed = await createRequestSigner({
      privateJwk: key.privateJwk,
      ttlSeconds: 3600,
    }).sign({ url: "https://crema.example/a" });
    expect(
      await verifySignedRequest({
        authority: "crema.example",
        headers: signed,
        resolveKey: () => key.publicJwk,
      }),
    ).toMatchObject({ ok: false, reason: "validity-too-long" });
  });

  it("accepts Express-style header objects and normalizes the authority", async () => {
    const key = await newKey();
    const signed = await createRequestSigner({ privateJwk: key.privateJwk }).sign({
      url: "https://Crema.Example/a",
    });
    const result = await verifySignedRequest({
      url: "https://crema.example:443/a",
      headers: { ...signed, "x-forwarded-for": ["1.2.3.4", "5.6.7.8"], "content-length": 0 },
      resolveKey: () => key.publicJwk,
    });
    expect(result.ok).toBe(true);
  });
});

describe("web bot auth: directory", () => {
  it("maps Signature-Agent origins to the well-known directory", () => {
    expect(signatureAgentHeader("http://localhost:3000/")).toBe('"http://localhost:3000"');
    expect(directoryUrlFor("https://botfare.example")).toBe(
      "https://botfare.example/.well-known/http-message-signatures-directory",
    );
    expect(directoryUrlFor("https://keys.example/jwks.json")).toBe(
      "https://keys.example/jwks.json",
    );
    expect(directoryUrlFor("data:application/json,{}")).toBeNull();
  });

  it("resolves keys from a trusted directory with a cache", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          keys: [
            { ...TEST_PUBLIC, kid: TEST_KID, use: "sig", botfare_key_id: "ak_test" },
            { kty: "OKP", crv: "Ed25519", x: TEST_X, d: "secret-must-be-dropped" },
            { kty: "RSA", n: "x", e: "AQAB" },
          ],
        }),
        { headers: { "content-type": SIGNATURE_DIRECTORY_MEDIA_TYPE } },
      );
    }) as typeof fetch;
    const resolve = createDirectoryKeyResolver({
      directoryUrl: "https://botfare.example/.well-known/http-message-signatures-directory",
      fetch: fakeFetch,
    });
    expect(await resolve(TEST_KID)).toMatchObject({ x: TEST_X, botfare_key_id: "ak_test" });
    expect(await resolve(TEST_KID)).not.toBeNull();
    expect(calls).toBe(1);
    // Unknown keyids refetch at most every 5 s.
    expect(await resolve("unknown")).toBeNull();
    expect(calls).toBe(1);
  });
});
