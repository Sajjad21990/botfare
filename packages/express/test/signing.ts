/**
 * Test-side signer for Web Bot Auth requests, written from the format documented in
 * src/detection/web-bot-auth.ts (the same one the SDK uses).
 */
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { jwkThumbprint } from "../src/detection";

export interface SigningKey {
  privateKey: KeyObject;
  publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  thumbprint: string;
}

export function generateSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x };
  return { privateKey, publicJwk, thumbprint: jwkThumbprint(publicJwk) };
}

export interface SignOptions {
  /** Request URL; its host is the signed @authority. */
  url: string;
  key: SigningKey;
  /** Signature-Agent value (an https URL); omit to send no Signature-Agent header. */
  signatureAgent?: string;
  created?: number;
  expires?: number;
  label?: string;
  tag?: string;
  /** Override the keyid (e.g. an unknown one). */
  keyid?: string;
}

/** Signature-Agent, Signature-Input and Signature headers for one request. */
export function signRequest(options: SignOptions): Record<string, string> {
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const expires = options.expires ?? created + 60;
  const label = options.label ?? "sig1";
  const authority = new URL(options.url).host.toLowerCase();
  const agentHeader = options.signatureAgent ? `"${options.signatureAgent}"` : undefined;
  const components = agentHeader ? `("@authority" "signature-agent")` : `("@authority")`;
  const nonce = randomBytes(32).toString("base64url");
  const params =
    `${components};created=${created};expires=${expires};keyid="${options.keyid ?? options.key.thumbprint}"` +
    `;alg="ed25519";nonce="${nonce}";tag="${options.tag ?? "web-bot-auth"}"`;
  const lines = [`"@authority": ${authority}`];
  if (agentHeader) lines.push(`"signature-agent": ${agentHeader}`);
  lines.push(`"@signature-params": ${params}`);
  const signature = sign(null, Buffer.from(lines.join("\n")), options.key.privateKey);
  return {
    ...(agentHeader ? { "signature-agent": agentHeader } : {}),
    "signature-input": `${label}=${params}`,
    signature: `${label}=:${signature.toString("base64")}:`,
  };
}
