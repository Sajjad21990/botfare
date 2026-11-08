/**
 * Signed agents, Web Bot Auth style: HTTP Message Signatures (RFC 9421) with Ed25519 keys that
 * BotFare publishes as a JWKS at `${BOTFARE_URL}/.well-known/http-message-signatures-directory`.
 *
 * The wire format, the signature base and the verification itself live in one shared module,
 * `@botfare/contracts/web-bot-auth`: the SDK signs with `createRequestSigner` and this file
 * verifies with `verifySignedRequest`, so signer and verifier cannot drift apart. A signed request
 * carries (the format Cloudflare verifies):
 *
 *   Signature-Agent: "https://botfare.example"
 *   Signature-Input: sig1=("@authority" "signature-agent");created=1762600000;keyid="<JWK thumbprint>";alg="ed25519";expires=1762600060;nonce="<base64url>";tag="web-bot-auth"
 *   Signature: sig1=:<base64 Ed25519 signature>:
 *
 * What this file adds for publishers: the key directory (always BotFare's own, from the
 * middleware's `botfareUrl`, never the URL a request names), the publisher's timing policy
 * (`created` at most 5 s in the future, lifetime at most 24 h), and proxies (the signed authority
 * may be the public host in X-Forwarded-Host).
 *
 * A signature that fails any check is ignored, never punished: the request is scored as if it
 * were unsigned.
 */
import { createHash } from "node:crypto";
import { SIGNATURE_DIRECTORY_PATH } from "@botfare/contracts";
import {
  BOTFARE_KEY_ID_MEMBER,
  type Ed25519PublicJwk,
  isEd25519PublicJwk,
  parseSignatureDirectory,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  SIGNATURE_HEADERS,
  verifySignedRequest,
  WEB_BOT_AUTH_TAG,
} from "@botfare/contracts/web-bot-auth";
import type { DetectionRequest } from "./types";

export { WEB_BOT_AUTH_TAG };

const CLOCK_SKEW_SECONDS = 5;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;

export type SignatureCheck =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; keyid: string; agentKeyId?: string };

// ---------------------------------------------------------------------------------------------
// Key directory

export interface DirectoryKey {
  thumbprint: string;
  jwk: Ed25519PublicJwk;
  /** The BotFare agent key ID (`ak_…`): the directory's `botfare_key_id`, or an `ak_` `kid`. */
  agentKeyId?: string;
  /** Optional validity window (Unix seconds) from the JWK's `nbf` / `exp`. */
  nbf?: number;
  exp?: number;
}

export interface SignatureDirectoryOptions {
  botfareUrl: string;
  /** How long a fetched directory is trusted. Default 5 min. */
  ttlMs?: number;
  /** An unknown keyid refetches the directory at most this often. Default 30 s. */
  minRefreshMs?: number;
  log?: (msg: string) => void;
}

const FETCH_TIMEOUT_MS = 3_000;

/**
 * RFC 7638 thumbprint of an Ed25519 public JWK (RFC 8037 A.3): SHA-256 over `{crv,kty,x}`.
 * Synchronous twin of the contracts' WebCrypto `jwkThumbprint`; both give the same value.
 */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical).digest("base64url");
}

/**
 * BotFare's JWKS of active agent keys, fetched only when a signed request arrives and cached for
 * `ttlMs`. A keyid missing from the cache triggers one refresh (rate limited), so a key created a
 * minute ago verifies without waiting for the TTL. A failed fetch keeps the last good keys.
 */
export class SignatureDirectory {
  readonly url: string;
  private keys = new Map<string, DirectoryKey>();
  private fetchedAt = 0;
  private attemptedAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly ttlMs: number;
  private readonly minRefreshMs: number;

  constructor(private readonly options: SignatureDirectoryOptions) {
    this.url = new URL(SIGNATURE_DIRECTORY_PATH, options.botfareUrl).toString();
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.minRefreshMs = options.minRefreshMs ?? 30_000;
  }

  async keyFor(keyid: string): Promise<DirectoryKey | undefined> {
    const now = Date.now();
    const stale = now - this.fetchedAt >= this.ttlMs;
    const unknown = !this.keys.has(keyid);
    if ((stale || unknown) && now - this.attemptedAt >= this.minRefreshMs) await this.refresh();
    return this.keys.get(keyid);
  }

  private refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    this.attemptedAt = Date.now();
    try {
      const res = await fetch(this.url, {
        headers: { accept: `${SIGNATURE_DIRECTORY_MEDIA_TYPE}, application/json` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const keys = new Map<string, DirectoryKey>();
      for (const jwk of parseSignatureDirectory(await res.json())) {
        const key = toDirectoryKey(jwk);
        keys.set(key.thumbprint, key);
      }
      this.keys = keys;
      this.fetchedAt = Date.now();
    } catch (err) {
      this.options.log?.(`signature directory fetch failed (${(err as Error).message})`);
    }
  }
}

function toDirectoryKey(jwk: Ed25519PublicJwk): DirectoryKey {
  const { kid, nbf, exp } = jwk;
  const named = jwk[BOTFARE_KEY_ID_MEMBER];
  const agentKeyId =
    typeof named === "string"
      ? named
      : typeof kid === "string" && kid.startsWith("ak_")
        ? kid
        : undefined;
  return {
    thumbprint: jwkThumbprint(jwk),
    jwk,
    agentKeyId,
    nbf: typeof nbf === "number" ? nbf : undefined,
    exp: typeof exp === "number" ? exp : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Verification

/** True when the request carries Web Bot Auth headers at all (cheap; no parsing). */
export function hasSignatureHeaders(req: DetectionRequest): boolean {
  return Boolean(req.get(SIGNATURE_HEADERS.signatureInput) && req.get(SIGNATURE_HEADERS.signature));
}

/**
 * The request headers the verifier may need: the three signature headers plus every quoted name
 * in Signature-Input (covered fields; anything else that matches is simply absent).
 */
function signedHeaders(req: DetectionRequest, inputHeader: string): Array<[string, string]> {
  const names = new Set<string>(Object.values(SIGNATURE_HEADERS));
  for (const match of inputHeader.matchAll(/"([a-z0-9][a-z0-9_.-]*)"/g)) {
    if (match[1]) names.add(match[1]);
  }
  const entries: Array<[string, string]> = [];
  for (const name of names) {
    const value = req.get(name);
    if (value !== undefined) entries.push([name, value]);
  }
  return entries;
}

export async function checkSignedAgent(
  req: DetectionRequest,
  directory: SignatureDirectory | undefined,
  nowSeconds: number,
): Promise<SignatureCheck> {
  const inputHeader = req.get(SIGNATURE_HEADERS.signatureInput);
  if (!inputHeader || !req.get(SIGNATURE_HEADERS.signature)) return { status: "absent" };
  if (!directory) return { status: "invalid", reason: "no key directory configured" };

  const headers = signedHeaders(req, inputHeader);
  const keys = new Map<string, DirectoryKey>();
  const resolveKey = async (keyid: string) => {
    const key = await directory.keyFor(keyid);
    if (!key || !isEd25519PublicJwk(key.jwk)) return null;
    if ((key.nbf && nowSeconds < key.nbf) || (key.exp && nowSeconds > key.exp)) return null;
    keys.set(keyid, key);
    return key.jwk;
  };

  // Behind a proxy the agent signed the public host; try X-Forwarded-Host as a second candidate.
  const hosts = [req.get("host"), req.get("x-forwarded-host")?.split(",")[0]?.trim()].filter(
    (h, i, all): h is string => Boolean(h) && all.indexOf(h) === i,
  );
  let reason = "no Host header";
  for (const host of hosts) {
    let url: URL;
    try {
      url = new URL(req.originalUrl, `${req.protocol.toLowerCase()}://${host}`);
    } catch {
      reason = "invalid host";
      continue;
    }
    const result = await verifySignedRequest({
      url,
      authority: host,
      method: req.method,
      headers: headers,
      resolveKey,
      now: nowSeconds,
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
      maxValiditySeconds: MAX_LIFETIME_SECONDS,
    });
    if (result.ok) {
      const agentKeyId = keys.get(result.keyid)?.agentKeyId ?? result.botfareKeyId ?? undefined;
      return { status: "valid", keyid: result.keyid, agentKeyId };
    }
    reason = `${result.reason}: ${result.message}`;
    // Only a signature mismatch depends on the authority; anything else fails for every host.
    if (result.reason !== "bad-signature") break;
  }
  return { status: "invalid", reason };
}
