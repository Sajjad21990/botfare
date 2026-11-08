import { SIGNATURE_DIRECTORY_PATH } from "@botfare/contracts";
import {
  createDirectoryKeyResolver,
  createRequestSigner,
  type Ed25519PrivateJwk,
  jwkThumbprint,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  verifySignedRequest,
} from "@botfare/contracts/web-bot-auth";
import { createAgentKey, createUser, revokeAgentKey } from "@botfare/core";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as directory } from "../src/app/.well-known/http-message-signatures-directory/route";
import { GET as lookup } from "../src/app/api/agents/[thumbprint]/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { useTestDatabase } from "./helpers";

const BOTFARE_URL = "http://botfare.test";
const DIRECTORY_URL = `${BOTFARE_URL}${SIGNATURE_DIRECTORY_PATH}`;

/** Serves the directory from the route handler, as a publisher's fetch would see it. */
const directoryFetch = (async (input: string | URL | Request) => {
  expect(String(input)).toBe(DIRECTORY_URL);
  return directory();
}) as typeof fetch;

async function lookupThumbprint(thumbprint: string) {
  return lookup(new Request(`${BOTFARE_URL}/api/agents/${thumbprint}`), {
    params: Promise.resolve({ thumbprint }),
  });
}

let keyId: string;
let thumbprint: string;
let privateJwk: Ed25519PrivateJwk;

beforeAll(async () => {
  useTestDatabase();
  const db = getDb();
  const tag = `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await createUser(db, { email: `${tag}@example.test`, name: tag });
  const keys = await generateAgentKeyPair();
  const key = await createAgentKey(db, {
    ownerUserId: owner.id,
    name: "signed agent",
    publicJwk: keys.publicJwk,
  });
  keyId = key.id;
  privateJwk = keys.privateJwk as Ed25519PrivateJwk;
  thumbprint = await jwkThumbprint(privateJwk);
});

afterAll(async () => {
  await closeDb();
});

describe("Web Bot Auth directory", () => {
  it("lists active keys as a JWKS with thumbprint kids and BotFare key IDs", async () => {
    const response = await directory();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(SIGNATURE_DIRECTORY_MEDIA_TYPE);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");

    const body = (await response.json()) as { keys: Record<string, unknown>[] };
    const entry = body.keys.find((k) => k.botfare_key_id === keyId);
    expect(entry).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: privateJwk.x,
      kid: thumbprint,
      use: "sig",
      botfare_key_id: keyId,
    });
    for (const key of body.keys) expect(key).not.toHaveProperty("d");
  });

  it("looks a key up by thumbprint without private fields", async () => {
    const response = await lookupThumbprint(thumbprint);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keyId, status: "active" });
    expect((await lookupThumbprint("not-a-thumbprint")).status).toBe(400);
    expect((await lookupThumbprint("A".repeat(43))).status).toBe(404);
  });

  it("verifies a signed request with the directory key; revoked keys drop out", async () => {
    const signed = await createRequestSigner({ privateJwk, signatureAgent: BOTFARE_URL }).sign({
      url: "https://crema.example/articles/one",
    });
    const resolveKey = createDirectoryKeyResolver({
      directoryUrl: DIRECTORY_URL,
      fetch: directoryFetch,
      cacheSeconds: 0,
      minRefetchSeconds: 0,
    });
    const verify = (authority = "crema.example") =>
      verifySignedRequest({ authority, headers: signed, resolveKey });

    expect(await verify()).toMatchObject({
      ok: true,
      keyid: thumbprint,
      botfareKeyId: keyId,
      directoryUrl: DIRECTORY_URL,
    });
    expect(await verify("other.example")).toMatchObject({ ok: false, reason: "bad-signature" });

    await revokeAgentKey(getDb(), { keyId });
    const body = (await (await directory()).json()) as { keys: { kid: string }[] };
    expect(body.keys.map((k) => k.kid)).not.toContain(thumbprint);
    expect(await verify()).toMatchObject({ ok: false, reason: "unknown-key" });
    expect(await (await lookupThumbprint(thumbprint)).json()).toEqual({ keyId, status: "revoked" });
  });
});
