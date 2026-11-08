/**
 * Signed agents, Web Bot Auth style: HTTP Message Signatures (RFC 9421) with Ed25519 keys that
 * BotFare publishes as a JWKS at `${BOTFARE_URL}/.well-known/http-message-signatures-directory`.
 *
 * What a signed request carries (the format Cloudflare verifies, which the SDK signs too):
 *
 *   Signature-Agent: "https://botfare.example"
 *   Signature-Input: sig1=("@authority" "signature-agent");created=1762600000;expires=1762600060;keyid="<JWK thumbprint>";alg="ed25519";nonce="<base64url>";tag="web-bot-auth"
 *   Signature: sig1=:<base64 Ed25519 signature>:
 *
 * The signature covers this base (RFC 9421 §2.5), lines joined by "\n", no trailing newline:
 *
 *   "@authority": publisher.example:4000
 *   "signature-agent": "https://botfare.example"
 *   "@signature-params": ("@authority" "signature-agent");created=…;expires=…;keyid="…";alg="ed25519";nonce="…";tag="web-bot-auth"
 *
 * Rules: the member tagged `web-bot-auth` is used (any label); `keyid` is the RFC 7638 / RFC 8037
 * SHA-256 JWK thumbprint (base64url) of the agent's public key; `created` and `expires` are
 * required, `created` may be at most 5 s in the future, the signature is refused after `expires`
 * (5 s skew) and may live at most 24 h; `alg`, if present, must be `ed25519`; `@authority` or
 * `@target-uri` must be covered, and `signature-agent` too when that header is sent.
 *
 * A signature that fails any check is ignored, never punished: the request is scored as if it
 * were unsigned.
 */
import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { SIGNATURE_DIRECTORY_PATH } from "@botfare/contracts";
import { parseDictionary, type SfItem } from "./structured-fields";
import type { DetectionRequest } from "./types";

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
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
  publicKey: KeyObject;
  /** The BotFare agent key ID (`ak_…`) when the directory names it in `kid`. */
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

/** RFC 7638 thumbprint of an Ed25519 public JWK (RFC 8037 A.3): SHA-256 over `{crv,kty,x}`. */
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
        headers: { accept: "application/http-message-signatures-directory+json, application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: unknown };
      const list = Array.isArray(body.keys) ? body.keys : body.keys ? [body.keys] : [];
      const keys = new Map<string, DirectoryKey>();
      for (const jwk of list) {
        const key = toDirectoryKey(jwk);
        if (key) keys.set(key.thumbprint, key);
      }
      this.keys = keys;
      this.fetchedAt = Date.now();
    } catch (err) {
      this.options.log?.(`signature directory fetch failed (${(err as Error).message})`);
    }
  }
}

function toDirectoryKey(jwk: unknown): DirectoryKey | undefined {
  if (!jwk || typeof jwk !== "object") return undefined;
  const { kty, crv, x, kid, nbf, exp, d } = jwk as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || d !== undefined) {
    return undefined;
  }
  try {
    const publicKey = createPublicKey({ key: { kty, crv, x }, format: "jwk" });
    return {
      thumbprint: jwkThumbprint({ kty, crv, x }),
      publicKey,
      agentKeyId: typeof kid === "string" && kid.startsWith("ak_") ? kid : undefined,
      nbf: typeof nbf === "number" ? nbf : undefined,
      exp: typeof exp === "number" ? exp : undefined,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Verification

/** True when the request carries Web Bot Auth headers at all (cheap; no parsing). */
export function hasSignatureHeaders(req: DetectionRequest): boolean {
  return Boolean(req.get("signature-input") && req.get("signature"));
}

export async function checkSignedAgent(
  req: DetectionRequest,
  directory: SignatureDirectory | undefined,
  nowSeconds: number,
): Promise<SignatureCheck> {
  const inputHeader = req.get("signature-input");
  const signatureHeader = req.get("signature");
  if (!inputHeader || !signatureHeader) return { status: "absent" };
  if (!directory) return { status: "invalid", reason: "no key directory configured" };

  let inputs: ReturnType<typeof parseDictionary>;
  let signatures: ReturnType<typeof parseDictionary>;
  try {
    inputs = parseDictionary(inputHeader);
    signatures = parseDictionary(signatureHeader);
  } catch {
    return { status: "invalid", reason: "malformed signature headers" };
  }

  // The member tagged web-bot-auth, whatever its label.
  const entry = [...inputs].find(([, m]) => m.list && m.params.get("tag") === WEB_BOT_AUTH_TAG);
  if (!entry) return { status: "invalid", reason: `no ${WEB_BOT_AUTH_TAG} signature` };
  const [label, input] = entry;
  const components = input.list as SfItem[];
  const sigValue = signatures.get(label)?.item?.value;
  if (!(sigValue instanceof Uint8Array)) {
    return { status: "invalid", reason: `no Signature for ${label}` };
  }

  const keyid = input.params.get("keyid");
  const created = input.params.get("created");
  const expires = input.params.get("expires");
  const alg = input.params.get("alg");
  if (typeof keyid !== "string" || !keyid) return { status: "invalid", reason: "missing keyid" };
  if (!Number.isInteger(created) || !Number.isInteger(expires)) {
    return { status: "invalid", reason: "missing created/expires" };
  }
  if (alg !== undefined && alg !== "ed25519") {
    return { status: "invalid", reason: `unsupported alg ${String(alg)}` };
  }
  const createdAt = created as number;
  const expiresAt = expires as number;
  if (createdAt > nowSeconds + CLOCK_SKEW_SECONDS) {
    return { status: "invalid", reason: "created in the future" };
  }
  if (nowSeconds > expiresAt + CLOCK_SKEW_SECONDS) return { status: "invalid", reason: "expired" };
  if (expiresAt < createdAt || expiresAt - createdAt > MAX_LIFETIME_SECONDS) {
    return { status: "invalid", reason: "lifetime above 24 h" };
  }

  const names = components.map((c) => c.value);
  if (!names.includes("@authority") && !names.includes("@target-uri")) {
    return { status: "invalid", reason: "@authority not covered" };
  }
  if (req.get("signature-agent") !== undefined && !names.includes("signature-agent")) {
    return { status: "invalid", reason: "signature-agent not covered" };
  }

  const key = await directory.keyFor(keyid);
  if (!key) return { status: "invalid", reason: "unknown keyid" };
  if ((key.nbf && nowSeconds < key.nbf) || (key.exp && nowSeconds > key.exp)) {
    return { status: "invalid", reason: "key outside its validity window" };
  }

  // Behind a proxy the agent signed the public host; try X-Forwarded-Host as a second candidate.
  const hosts = [req.get("host"), req.get("x-forwarded-host")?.split(",")[0]?.trim()].filter(
    (h, i, all): h is string => Boolean(h) && all.indexOf(h) === i,
  );
  for (const host of hosts) {
    const base = signatureBase(req, host, components, input.raw);
    if (base === undefined) return { status: "invalid", reason: "uncoverable component" };
    if (verify(null, Buffer.from(base, "utf8"), key.publicKey, sigValue)) {
      return { status: "valid", keyid, agentKeyId: key.agentKeyId };
    }
  }
  return { status: "invalid", reason: "bad signature" };
}

/** The RFC 9421 signature base, or undefined when a covered component cannot be produced. */
export function signatureBase(
  req: DetectionRequest,
  host: string,
  components: SfItem[],
  signatureParams: string,
): string | undefined {
  const lines: string[] = [];
  for (const component of components) {
    const value = componentValue(req, host, component);
    if (value === undefined) return undefined;
    lines.push(`${component.raw}: ${value}`);
  }
  lines.push(`"@signature-params": ${signatureParams}`);
  return lines.join("\n");
}

function componentValue(
  req: DetectionRequest,
  host: string,
  component: SfItem,
): string | undefined {
  const name = component.value;
  if (typeof name !== "string") return undefined;
  const scheme = req.protocol.toLowerCase();
  const url = new URL(req.originalUrl, `${scheme}://${host}`);
  switch (name) {
    case "@authority":
      return authority(host, scheme);
    case "@method":
      return req.method.toUpperCase();
    case "@scheme":
      return scheme;
    case "@target-uri":
      return `${scheme}://${authority(host, scheme)}${url.pathname}${url.search}`;
    case "@request-target":
      return `${url.pathname}${url.search}`;
    case "@path":
      return url.pathname;
    case "@query":
      return url.search || "?";
  }
  if (name.startsWith("@") || name !== name.toLowerCase()) return undefined;
  const raw = req.get(name);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  const member = component.params.get("key");
  if (member === undefined) return value;
  // `"signature-agent";key="sig1"`: the serialized dictionary member (draft's dictionary form).
  if (typeof member !== "string") return undefined;
  try {
    return parseDictionary(value).get(member)?.raw;
  } catch {
    return undefined;
  }
}

/** Host as RFC 9421 wants it: lower case, default port dropped. */
function authority(host: string, scheme: string): string {
  const lower = host.toLowerCase();
  if (scheme === "http" && lower.endsWith(":80")) return lower.slice(0, -3);
  if (scheme === "https" && lower.endsWith(":443")) return lower.slice(0, -4);
  return lower;
}
