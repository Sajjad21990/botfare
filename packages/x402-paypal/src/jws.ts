import {
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import { z } from "zod";
import { AUTHORIZATION_TYPE, CLOCK_SKEW_SECONDS, MAX_AUTHORIZATION_SECONDS } from "./constants";

export const ALG = "EdDSA";

/** What the agent signs for one payment. Mirrors the fields of the accepted requirements. */
export const authorizationClaimsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  nonce: z.string().min(16),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type AuthorizationClaims = z.infer<typeof authorizationClaimsSchema>;

export interface AgentKeyPair {
  publicJwk: JWK;
  privateJwk: JWK;
}

/** Ed25519 key pair for an agent. Only the public JWK is ever stored by BotFare. */
export async function generateAgentKeyPair(): Promise<AgentKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  return { publicJwk: await exportJWK(publicKey), privateJwk: await exportJWK(privateKey) };
}

export async function signAuthorization(
  claims: AuthorizationClaims,
  keyId: string,
  privateJwk: JWK,
): Promise<string> {
  const key = await importJWK(privateJwk, ALG);
  const { iat, exp, ...rest } = claims;
  return new SignJWT(rest satisfies JWTPayload)
    .setProtectedHeader({ alg: ALG, kid: keyId, typ: AUTHORIZATION_TYPE })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
}

/** Reads the key ID without verifying anything, so the facilitator can look up the public key. */
export function readKeyId(token: string): string | undefined {
  try {
    const header = decodeProtectedHeader(token);
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

export type VerifyAuthorizationResult =
  | { ok: true; claims: AuthorizationClaims }
  | { ok: false; error: "expired" | "bad_time" | "bad_signature" | "malformed" };

export async function verifyAuthorization(
  token: string,
  publicJwk: JWK,
  now: Date = new Date(),
): Promise<VerifyAuthorizationResult> {
  try {
    const key = await importJWK(publicJwk, ALG);
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      typ: AUTHORIZATION_TYPE,
      clockTolerance: CLOCK_SKEW_SECONDS,
      // Rejects an iat in the future or older than 60 s, so a fast agent clock or a
      // forward-dated token cannot stretch the authorization window.
      maxTokenAge: MAX_AUTHORIZATION_SECONDS,
      currentDate: now,
      requiredClaims: ["iat", "exp"],
    });
    const parsed = authorizationClaimsSchema.safeParse(payload);
    return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, error: "malformed" };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, error: "expired" };
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && (err as { claim?: string }).claim === "iat") {
      return { ok: false, error: "bad_time" };
    }
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED")
      return { ok: false, error: "bad_signature" };
    return { ok: false, error: "malformed" };
  }
}
