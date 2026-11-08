/**
 * BotFare's receipt-signing keys (decision 18, signed receipts). Ed25519 keys are derived
 * deterministically from secret seeds, so every instance of the app signs with the same key and
 * nothing private is stored in the database:
 *
 *   32-byte private seed = HKDF-SHA256(ikm = seed string, salt = empty, info = "botfare-receipt-key-v1")
 *   kid                  = RFC 7638 thumbprint of the public JWK
 *
 * BOTFARE_RECEIPT_KEY_SEED signs. BOTFARE_RECEIPT_KEY_SEED_PREVIOUS (optional, comma-separated)
 * names retired seeds: their public keys stay in the JWKS so old statements keep verifying, but
 * they never sign. Private keys never leave this process.
 */
import { createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "node:crypto";
import { publicJwk } from "@botfare/contracts/receipts";
import { calculateJwkThumbprint, type JSONWebKeySet, type JWK } from "jose";

export const RECEIPT_KEY_HKDF_INFO = "botfare-receipt-key-v1";
export const MIN_RECEIPT_SEED_LENGTH = 32;

/**
 * Used only outside production when BOTFARE_RECEIPT_KEY_SEED is empty. Public on purpose: anything
 * signed with it proves nothing, and production refuses it.
 */
export const DEV_RECEIPT_KEY_SEED = "botfare-development-receipt-seed-NOT-FOR-PRODUCTION";

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 private seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface ReceiptSigningKey {
  kid: string;
  /** Never serialized; only used by signStatement. */
  privateKey: KeyObject;
  /** `{ kty, crv, x, kid, alg: "EdDSA", use: "sig" }`. */
  publicJwk: JWK;
}

export interface ReceiptKeyring {
  /** Origin written as `iss` in every statement (BOTFARE_URL's origin). */
  issuer: string;
  /** The key that signs; null when signing is refused (production without a real seed). */
  active: ReceiptSigningKey | null;
  /** Retired public keys, still published so their statements keep verifying. */
  previous: JWK[];
  /** True when signing with the public development seed. */
  development: boolean;
  /** Why `active` is null (logged once), if it is. */
  problem: string | null;
}

/** Derives the Ed25519 receipt key for a seed string (deterministic). */
export async function deriveReceiptKey(seed: string): Promise<ReceiptSigningKey> {
  if (seed.length < MIN_RECEIPT_SEED_LENGTH) {
    throw new Error(`A receipt key seed needs at least ${MIN_RECEIPT_SEED_LENGTH} characters`);
  }
  const raw = Buffer.from(
    hkdfSync("sha256", Buffer.from(seed, "utf8"), Buffer.alloc(0), RECEIPT_KEY_HKDF_INFO, 32),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  const exported = createPublicKey(privateKey).export({ format: "jwk" }) as JWK;
  const base = { kty: exported.kty, crv: exported.crv, x: exported.x } as JWK;
  const kid = await calculateJwkThumbprint(base, "sha256");
  return { kid, privateKey, publicJwk: { ...base, kid, alg: "EdDSA", use: "sig" } };
}

type Env = Record<string, string | undefined>;

/**
 * The keyring from the environment. Never throws: a missing or unusable seed in production gives
 * `active: null` and a `problem` (settlement goes on; statements are then null).
 */
export async function receiptKeyringFromEnv(env: Env = process.env): Promise<ReceiptKeyring> {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];

  let issuer: string | null = null;
  try {
    issuer = env.BOTFARE_URL ? new URL(env.BOTFARE_URL).origin : null;
  } catch {
    problems.push("BOTFARE_URL is not a URL");
  }
  if (!issuer) {
    if (production) problems.push("BOTFARE_URL is not set");
    issuer = "http://localhost:3000";
  }

  const seed = env.BOTFARE_RECEIPT_KEY_SEED?.trim() ?? "";
  let development = false;
  let active: ReceiptSigningKey | null = null;
  if (seed.length >= MIN_RECEIPT_SEED_LENGTH && seed !== DEV_RECEIPT_KEY_SEED) {
    active = await deriveReceiptKey(seed);
  } else if (production) {
    problems.push(
      seed
        ? `BOTFARE_RECEIPT_KEY_SEED must be a secret of at least ${MIN_RECEIPT_SEED_LENGTH} characters`
        : "BOTFARE_RECEIPT_KEY_SEED is not set",
    );
  } else {
    if (seed) {
      problems.push(
        `BOTFARE_RECEIPT_KEY_SEED is shorter than ${MIN_RECEIPT_SEED_LENGTH} characters; using the development seed`,
      );
    }
    development = true;
    active = await deriveReceiptKey(DEV_RECEIPT_KEY_SEED);
  }
  if (production && problems.length > 0) active = null;

  const previous: JWK[] = [];
  for (const old of (env.BOTFARE_RECEIPT_KEY_SEED_PREVIOUS ?? "").split(",")) {
    const trimmed = old.trim();
    if (!trimmed) continue;
    if (trimmed.length < MIN_RECEIPT_SEED_LENGTH) {
      problems.push("A BOTFARE_RECEIPT_KEY_SEED_PREVIOUS entry is too short and was skipped");
      continue;
    }
    const key = await deriveReceiptKey(trimmed);
    if (key.kid !== active?.kid && !previous.some((jwk) => jwk.kid === key.kid)) {
      previous.push(key.publicJwk);
    }
  }

  return {
    issuer,
    active,
    previous,
    development,
    problem: problems.length > 0 ? problems.join("; ") : null,
  };
}

/** The public JWKS for a keyring: the active key first, then retired ones. Never contains `d`. */
export function receiptJwks(keyring: ReceiptKeyring): JSONWebKeySet {
  const keys = [keyring.active?.publicJwk, ...keyring.previous]
    .filter((jwk): jwk is JWK => jwk !== undefined)
    .map((jwk) => publicJwk(jwk));
  return { keys };
}

// ---------------------------------------------------------------------------------------------
// The process-wide keyring (read from process.env once)

const globalForKeys = globalThis as typeof globalThis & {
  __botfareReceiptKeyring?: Promise<ReceiptKeyring>;
};

/** The keyring for this process, read from the environment on first use and logged once. */
export function getReceiptKeyring(): Promise<ReceiptKeyring> {
  globalForKeys.__botfareReceiptKeyring ??= receiptKeyringFromEnv().then((keyring) => {
    if (keyring.problem && !keyring.active) {
      console.error(`[receipts] signing disabled: ${keyring.problem}`);
    } else if (keyring.problem) {
      console.warn(`[receipts] ${keyring.problem}`);
    }
    if (keyring.development && keyring.active) {
      console.warn(
        `[receipts] signing with the public DEVELOPMENT seed (kid ${keyring.active.kid}); set BOTFARE_RECEIPT_KEY_SEED`,
      );
    }
    return keyring;
  });
  return globalForKeys.__botfareReceiptKeyring;
}

/** Replaces the process keyring (tests), or forgets it so the environment is read again. */
export function setReceiptKeyring(keyring: ReceiptKeyring | undefined): void {
  globalForKeys.__botfareReceiptKeyring = keyring ? Promise.resolve(keyring) : undefined;
}
