/**
 * Spike 04: an agent's Ed25519 payment authorization verifies, and tampering or expiry fails.
 */
import {
  type AuthorizationClaims,
  generateAgentKeyPair,
  signAuthorization,
  verifyAuthorization,
} from "@botfare/x402-paypal";
import { decodeJwt } from "jose";

let failures = 0;
function report(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const { publicJwk, privateJwk } = await generateAgentKeyPair();
const now = Math.floor(Date.now() / 1000);
const claims: AuthorizationClaims = {
  scheme: "prepaid",
  network: "paypal:sandbox",
  asset: "USD",
  amount: "3",
  payTo: "site_8f2a",
  nonce: crypto.randomUUID(),
  iat: now,
  exp: now + 60,
};

const token = await signAuthorization(claims, "ak_demo", privateJwk);
console.log(`Signed authorization (${token.length} chars): ${token.slice(0, 48)}...`);
console.log("Claims:", decodeJwt(token));

const valid = await verifyAuthorization(token, publicJwk);
report("Valid signature verifies", valid.ok && valid.claims.amount === "3");

// Change the amount in the signed payload without re-signing
const [header, , signature] = token.split(".");
const tamperedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(token), amount: "1" })).toString(
  "base64url",
);
const tampered = await verifyAuthorization(`${header}.${tamperedPayload}.${signature}`, publicJwk);
report(
  "Tampered amount fails",
  !tampered.ok && tampered.error === "bad_signature",
  tampered.ok ? "" : tampered.error,
);

const otherKey = await generateAgentKeyPair();
const wrongKey = await verifyAuthorization(token, otherKey.publicJwk);
report("Another agent's key fails", !wrongKey.ok, wrongKey.ok ? "" : wrongKey.error);

const expiredToken = await signAuthorization(
  { ...claims, iat: now - 120, exp: now - 60 },
  "ak_demo",
  privateJwk,
);
const expired = await verifyAuthorization(expiredToken, publicJwk);
report(
  "Expired authorization fails",
  !expired.ok && expired.error === "expired",
  expired.ok ? "" : expired.error,
);

console.log(failures === 0 ? "\nSpike 04: ALL PASS" : `\nSpike 04: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
