import { SIGNATURE_DIRECTORY_PATH } from "@botfare/contracts";
import {
  createDirectoryKeyResolver,
  type Ed25519PublicJwk,
  jwkThumbprint,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  verifySignedRequest,
} from "@botfare/contracts/web-bot-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBotFareAgent } from "../src";
import { KEY_ID, type SeenRequest, startStack } from "./harness";

let stack: Awaited<ReturnType<typeof startStack>>;
let publicJwk: Ed25519PublicJwk;
let thumbprint: string;

beforeAll(async () => {
  stack = await startStack();
  publicJwk = stack.publicJwk as Ed25519PublicJwk;
  thumbprint = await jwkThumbprint(publicJwk);
});

afterAll(async () => {
  await stack.stop();
});

const BOTFARE_URL = "https://botfare.example";
const DIRECTORY_URL = `${BOTFARE_URL}${SIGNATURE_DIRECTORY_PATH}`;

/** BotFare's directory as apps/web serves it, with `revoked` keys left out. */
function directoryFetch(revoked: () => boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    expect(String(input)).toBe(DIRECTORY_URL);
    const keys = revoked()
      ? []
      : [{ ...publicJwk, kid: thumbprint, use: "sig", botfare_key_id: KEY_ID }];
    return new Response(JSON.stringify({ keys }), {
      headers: { "content-type": SIGNATURE_DIRECTORY_MEDIA_TYPE },
    });
  }) as typeof fetch;
}

function verifySeen(
  request: SeenRequest,
  resolveKey: Parameters<typeof verifySignedRequest>[0]["resolveKey"],
  extra: Partial<Parameters<typeof verifySignedRequest>[0]> = {},
) {
  return verifySignedRequest({
    authority: request.host,
    headers: request.headers,
    resolveKey,
    ...extra,
  });
}

describe("signed agent requests (Web Bot Auth)", () => {
  it("signs getOffer and both legs of a paid fetch; each verifies with the directory key", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: BOTFARE_URL });
    const from = stack.seen.length;
    await agent.getOffer(`${stack.siteUrl}/articles/burr-basics`);
    const result = await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
    expect(result.paid).toBe(true);

    const requests = stack.seen.slice(from);
    expect(requests.map((r) => r.paymentSignature)).toEqual([false, false, true]);
    expect(await agent.signatureKeyId()).toBe(thumbprint);

    const resolveKey = createDirectoryKeyResolver({
      directoryUrl: DIRECTORY_URL,
      fetch: directoryFetch(() => false),
    });
    const nonces = new Set<string>();
    for (const request of requests) {
      expect(request.headers["signature-agent"]).toBe(`"${BOTFARE_URL}"`);
      expect(request.headers["signature-input"]).toMatch(
        new RegExp(
          `^sig1=\\("@authority" "signature-agent"\\);created=(\\d+);keyid="${thumbprint}";alg="ed25519";expires=\\d+;nonce="[A-Za-z0-9_-]{86}";tag="web-bot-auth"$`,
        ),
      );
      const verified = await verifySeen(request, resolveKey);
      expect(verified).toMatchObject({
        ok: true,
        keyid: thumbprint,
        botfareKeyId: KEY_ID,
        signatureAgent: BOTFARE_URL,
        directoryUrl: DIRECTORY_URL,
      });
      if (verified.ok) {
        expect(verified.expires - verified.created).toBe(60);
        nonces.add(verified.nonce ?? "");
      }
    }
    // The paid retry carries a fresh signature, not a copy of the first one.
    expect(nonces.size).toBe(3);
  });

  it("fails for a tampered authority, after expiry, and once the key is revoked", async () => {
    const agent = createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: BOTFARE_URL });
    const from = stack.seen.length;
    await agent.getOffer(`${stack.siteUrl}/articles/burr-basics`);
    const [request] = stack.seen.slice(from);
    if (!request) throw new Error("no request seen");

    let revoked = false;
    const resolveKey = createDirectoryKeyResolver({
      directoryUrl: DIRECTORY_URL,
      fetch: directoryFetch(() => revoked),
      cacheSeconds: 0,
      minRefetchSeconds: 0,
    });

    expect((await verifySeen(request, resolveKey)).ok).toBe(true);
    expect(await verifySeen(request, resolveKey, { authority: "crema.example" })).toMatchObject({
      ok: false,
      reason: "bad-signature",
    });
    expect(
      await verifySeen(request, resolveKey, { now: Math.floor(Date.now() / 1000) + 61 }),
    ).toMatchObject({ ok: false, reason: "expired" });

    revoked = true;
    expect(await verifySeen(request, resolveKey)).toMatchObject({
      ok: false,
      reason: "unknown-key",
    });
  });

  it("reads BOTFARE_URL from the environment by default", async () => {
    const previous = process.env.BOTFARE_URL;
    process.env.BOTFARE_URL = "http://localhost:3100/ignored/path";
    try {
      const agent = createBotFareAgent({ agentKey: stack.agentKey });
      const from = stack.seen.length;
      await agent.getOffer(`${stack.siteUrl}/free`);
      expect(stack.seen[from]?.headers["signature-agent"]).toBe('"http://localhost:3100"');
    } finally {
      if (previous === undefined) delete process.env.BOTFARE_URL;
      else process.env.BOTFARE_URL = previous;
    }
  });

  it("signs without Signature-Agent when no BotFare URL is known", async () => {
    const previous = process.env.BOTFARE_URL;
    delete process.env.BOTFARE_URL;
    try {
      const agent = createBotFareAgent({ agentKey: stack.agentKey });
      const from = stack.seen.length;
      await agent.getOffer(`${stack.siteUrl}/free`);
      const request = stack.seen[from];
      if (!request) throw new Error("no request seen");
      expect(request.headers["signature-agent"]).toBeUndefined();
      expect(request.headers["signature-input"]).toContain('sig1=("@authority");');
      expect((await verifySeen(request, () => publicJwk)).ok).toBe(true);
    } finally {
      if (previous !== undefined) process.env.BOTFARE_URL = previous;
    }
  });

  it("sends no signature headers with signRequests: false", async () => {
    const agent = createBotFareAgent({
      agentKey: stack.agentKey,
      botfareUrl: BOTFARE_URL,
      signRequests: false,
    });
    const from = stack.seen.length;
    await agent.fetch(`${stack.siteUrl}/articles/burr-basics`);
    const requests = stack.seen.slice(from);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers["signature-input"]).toBeUndefined();
      expect(request.headers.signature).toBeUndefined();
      expect(request.headers["signature-agent"]).toBeUndefined();
    }
    expect(await agent.signatureKeyId()).toBeNull();
  });

  it("rejects a botfareUrl that is not an absolute URL", () => {
    expect(() => createBotFareAgent({ agentKey: stack.agentKey, botfareUrl: "botfare" })).toThrow(
      /absolute URL/,
    );
  });
});
