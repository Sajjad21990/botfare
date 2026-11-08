/**
 * Signed agents, Web Bot Auth style: RFC 9421 HTTP Message Signatures with Ed25519.
 *
 * BotFare agents sign every request they send; publishers (packages/express) verify the signature
 * against the public keys BotFare lists at `${BOTFARE_URL}${SIGNATURE_DIRECTORY_PATH}`. A valid
 * signature is the "signed-agent" detection signal.
 *
 * Wire format (the one Cloudflare's Web Bot Auth verifier accepts, from
 * draft-meunier-web-bot-auth-architecture / draft-meunier-http-message-signatures-directory-03):
 *
 *   Signature-Agent: "https://botfare.example"
 *   Signature-Input: sig1=("@authority" "signature-agent");created=1735689600;
 *                    keyid="<RFC 7638 JWK thumbprint>";alg="ed25519";expires=1735689660;
 *                    nonce="<64 random bytes, base64url>";tag="web-bot-auth"
 *   Signature: sig1=:<base64 Ed25519 signature>:
 *
 * The verifier also accepts the newer dictionary form of Signature-Agent
 * (`Signature-Agent: agent1="https://..."` covered as `"signature-agent";key="agent1"`).
 *
 * Pure WebCrypto, TextEncoder and btoa/atob: runs in Node 20+ and in current browsers, no Buffer.
 */
import { SIGNATURE_DIRECTORY_PATH } from "./index";

// ---------------------------------------------------------------------------------------------
// Constants

/** `tag` of a request signature from an agent. */
export const WEB_BOT_AUTH_TAG = "web-bot-auth";
/** `tag` of a signature on a directory response (not used by BotFare; see apps/web). */
export const DIRECTORY_SIGNATURE_TAG = "http-message-signatures-directory";
/** Content type of the key directory. */
export const SIGNATURE_DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json";
/** Agents sign with a 60-second window. */
export const SIGNATURE_TTL_SECONDS = 60;
/** The label BotFare agents use for their signature. */
export const SIGNATURE_LABEL = "sig1";
/** Extra JWK member in BotFare's directory carrying the agent key ID (`ak_...`). */
export const BOTFARE_KEY_ID_MEMBER = "botfare_key_id";

export const SIGNATURE_HEADERS = {
  signatureAgent: "signature-agent",
  signatureInput: "signature-input",
  signature: "signature",
} as const;

// ---------------------------------------------------------------------------------------------
// Keys

export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid?: string;
  [member: string]: unknown;
}

export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string;
}

/** A JWKS entry in BotFare's directory. */
export interface DirectoryJwk extends Ed25519PublicJwk {
  kid: string;
  use: "sig";
  [BOTFARE_KEY_ID_MEMBER]: string;
}

export interface SignatureDirectory {
  keys: DirectoryJwk[];
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) of an Ed25519 key, as RFC 8037 A.3 computes it. */
export async function jwkThumbprint(
  jwk: Pick<Ed25519PublicJwk, "kty" | "crv" | "x">,
): Promise<string> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new TypeError("jwkThumbprint expects an Ed25519 (OKP) JWK");
  }
  // Required members only, in lexicographic order, no whitespace.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToBase64Url(new Uint8Array(digest));
}

function importPrivateKey(jwk: Ed25519PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

function importPublicKey(jwk: Ed25519PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

export function isEd25519PublicJwk(value: unknown): value is Ed25519PublicJwk {
  if (!value || typeof value !== "object") return false;
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === "OKP" &&
    jwk.crv === "Ed25519" &&
    typeof jwk.x === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(jwk.x) &&
    !("d" in jwk)
  );
}

// ---------------------------------------------------------------------------------------------
// Signature-Agent and the directory URL

/** `Signature-Agent` header value for a BotFare app URL: the quoted origin (sf-string). */
export function signatureAgentHeader(botfareUrl: string | URL): string {
  return serializeString(new URL(botfareUrl).origin);
}

/**
 * Where to fetch the directory for a Signature-Agent URI: a bare origin gets the well-known path
 * (`/.well-known/http-message-signatures-directory`); a URI with a path is used as given.
 * Null for anything but http(s).
 */
export function directoryUrlFor(signatureAgent: string): string | null {
  let url: URL;
  try {
    url = new URL(signatureAgent);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname === "/" && !url.search) return `${url.origin}${SIGNATURE_DIRECTORY_PATH}`;
  return url.href;
}

// ---------------------------------------------------------------------------------------------
// Signing

export interface SignRequestInput {
  url: string | URL;
  /** Request headers; needed only if a covered header (signature-agent) is not set by the signer. */
  headers?: HeadersLike;
}

export interface RequestSignerOptions {
  privateJwk: Ed25519PrivateJwk;
  /** BotFare app URL (or any directory host); sent as Signature-Agent. Null: no Signature-Agent. */
  signatureAgent?: string | URL | null;
  /** Validity window in seconds; default 60. */
  ttlSeconds?: number;
  /**
   * Send a random nonce (64 bytes, base64url) as the draft recommends; default true. A string is
   * sent as is (test vectors only: a nonce must be unique).
   */
  nonce?: boolean | string;
  /** Signature label; default "sig1". */
  label?: string;
  /** Clock in Unix seconds (tests). */
  now?: () => number;
}

/** The headers a signed request carries; set them all on the outgoing request. */
export type WebBotAuthHeaders = {
  "signature-agent"?: string;
  "signature-input": string;
  signature: string;
};

export interface RequestSigner {
  /** The `keyid` in every signature: the JWK thumbprint of the public key. */
  keyid(): Promise<string>;
  sign(request: SignRequestInput): Promise<WebBotAuthHeaders>;
}

/** A signer that imports the key once and signs many requests. */
export function createRequestSigner(options: RequestSignerOptions): RequestSigner {
  const label = options.label ?? SIGNATURE_LABEL;
  if (!/^[a-z*][a-z0-9_\-.*]*$/.test(label))
    throw new TypeError(`Invalid signature label: ${label}`);
  const ttl = options.ttlSeconds ?? SIGNATURE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1)
    throw new RangeError("ttlSeconds must be a positive integer");
  const agentHeader =
    options.signatureAgent != null ? signatureAgentHeader(options.signatureAgent) : null;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const withNonce = options.nonce ?? true;

  let keyPromise: Promise<CryptoKey> | undefined;
  let keyidPromise: Promise<string> | undefined;
  const keyid = () => {
    keyidPromise ??= jwkThumbprint(options.privateJwk);
    return keyidPromise;
  };

  return {
    keyid,
    async sign(request) {
      keyPromise ??= importPrivateKey(options.privateJwk);
      const target = new URL(request.url);
      const created = now();
      // Parameter order as in the draft's test vectors.
      const params: Params = new Map<string, BareItem>([
        ["created", created],
        ["keyid", await keyid()],
        ["alg", "ed25519"],
        ["expires", created + ttl],
      ]);
      if (typeof withNonce === "string") params.set("nonce", withNonce);
      else if (withNonce) params.set("nonce", bytesToBase64Url(randomBytes(64)));
      params.set("tag", WEB_BOT_AUTH_TAG);

      const components: Item[] = [{ value: "@authority", params: new Map() }];
      const headers = toHeaders(request.headers);
      if (agentHeader) {
        headers.set(SIGNATURE_HEADERS.signatureAgent, agentHeader);
        components.push({ value: "signature-agent", params: new Map() });
      }
      const signatureParams: InnerList = { items: components, params };
      const base = signatureBase(signatureParams, { url: target, headers });
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" },
        await keyPromise,
        new TextEncoder().encode(base),
      );
      return {
        ...(agentHeader ? { "signature-agent": agentHeader } : {}),
        "signature-input": `${label}=${serializeInnerList(signatureParams)}`,
        signature: `${label}=${serializeBareItem(new Uint8Array(signature))}`,
      };
    },
  };
}

/** One-shot signing; prefer createRequestSigner for many requests. */
export function signRequest(
  request: SignRequestInput,
  options: RequestSignerOptions,
): Promise<WebBotAuthHeaders> {
  return createRequestSigner(options).sign(request);
}

// ---------------------------------------------------------------------------------------------
// Verification

export type HeadersLike =
  | Headers
  | Record<string, string | string[] | number | undefined>
  | Iterable<[string, string]>;

export interface VerifySignedRequestOptions {
  /** Request URL (scheme, host, path); used for @authority unless `authority` is given. */
  url?: string | URL;
  /** The request's authority (Host header), lowercase host[:port]. Overrides `url`'s. */
  authority?: string;
  method?: string;
  headers: HeadersLike;
  /**
   * Public key for a `keyid` (JWK thumbprint), or null if unknown. `signatureAgent` is the URI the
   * request named, for information: resolve keys from a directory you trust, never one a request
   * points at (see createDirectoryKeyResolver).
   */
  resolveKey(
    keyid: string,
    context: { signatureAgent: string | null },
  ): Promise<Ed25519PublicJwk | null> | Ed25519PublicJwk | null;
  /** Clock in Unix seconds; default now. */
  now?: number;
  /** Longest accepted `expires - created`; default 300 s (BotFare agents use 60 s). */
  maxValiditySeconds?: number;
  /** Tolerated clock skew for `created` in the future; default 30 s. */
  clockSkewSeconds?: number;
}

export type VerifyFailureReason =
  /** No Signature-Input/Signature headers: not a signed request. */
  | "missing"
  /** Headers do not parse as RFC 8941 structured fields, or required parameters are absent. */
  | "malformed"
  /** Signature-Input has no signature tagged "web-bot-auth". */
  | "wrong-tag"
  /** A covered component BotFare cannot reproduce (unsupported derived component or parameter). */
  | "unsupported"
  /** @authority (or @target-uri) is not covered, or Signature-Agent is sent but not covered. */
  | "missing-component"
  | "expired"
  | "not-yet-valid"
  | "validity-too-long"
  | "unknown-key"
  | "bad-signature";

export type VerifySignedRequestResult =
  | {
      ok: true;
      keyid: string;
      label: string;
      /** BotFare agent key ID (`ak_...`) from the directory entry, when present. */
      botfareKeyId: string | null;
      signatureAgent: string | null;
      directoryUrl: string | null;
      created: number;
      expires: number;
      nonce: string | null;
      jwk: Ed25519PublicJwk;
    }
  | { ok: false; reason: VerifyFailureReason; message: string; keyid?: string };

function fail(
  reason: VerifyFailureReason,
  message: string,
  keyid?: string,
): VerifySignedRequestResult {
  return { ok: false, reason, message, ...(keyid ? { keyid } : {}) };
}

/** Verifies the first `web-bot-auth` signature on a request. Never throws on bad input. */
export async function verifySignedRequest(
  options: VerifySignedRequestOptions,
): Promise<VerifySignedRequestResult> {
  const headers = toHeaders(options.headers);
  const inputHeader = headers.get(SIGNATURE_HEADERS.signatureInput);
  const signatureHeader = headers.get(SIGNATURE_HEADERS.signature);
  if (!inputHeader && !signatureHeader) return fail("missing", "Request is not signed");
  if (!inputHeader || !signatureHeader) {
    return fail("malformed", "Signature-Input and Signature must be sent together");
  }

  let inputs: Dictionary;
  let signatures: Dictionary;
  try {
    inputs = parseDictionary(inputHeader);
    signatures = parseDictionary(signatureHeader);
  } catch (err) {
    return fail("malformed", `Unparseable signature headers: ${(err as Error).message}`);
  }

  let label: string | undefined;
  let signatureParams: InnerList | undefined;
  for (const [name, member] of inputs) {
    if (isInnerList(member) && member.params.get("tag") === WEB_BOT_AUTH_TAG) {
      label = name;
      signatureParams = member;
      break;
    }
  }
  if (!label || !signatureParams) {
    return fail("wrong-tag", `No signature with tag="${WEB_BOT_AUTH_TAG}"`);
  }

  const signatureMember = signatures.get(label);
  if (
    !signatureMember ||
    isInnerList(signatureMember) ||
    !(signatureMember.value instanceof Uint8Array)
  ) {
    return fail("malformed", `Signature has no byte sequence for ${label}`);
  }
  const signature = signatureMember.value;

  const { params } = signatureParams;
  const keyid = params.get("keyid");
  const created = params.get("created");
  const expires = params.get("expires");
  const alg = params.get("alg");
  const nonce = params.get("nonce");
  if (typeof keyid !== "string" || !keyid) return fail("malformed", "keyid is required");
  if (!isInteger(created) || !isInteger(expires)) {
    return fail("malformed", "created and expires are required integers", keyid);
  }
  if (alg !== undefined && alg !== "ed25519") {
    return fail("unsupported", `Unsupported alg ${String(alg)}`, keyid);
  }

  // Timing.
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  const maxValidity = options.maxValiditySeconds ?? 300;
  if (expires <= created) return fail("malformed", "expires must be after created", keyid);
  if (expires - created > maxValidity) {
    return fail("validity-too-long", `Validity window exceeds ${maxValidity} s`, keyid);
  }
  if (created > now + skew) return fail("not-yet-valid", "created is in the future", keyid);
  if (expires < now) return fail("expired", "Signature has expired", keyid);

  // Required coverage.
  const names = signatureParams.items.map((item) => item.value);
  if (!names.includes("@authority") && !names.includes("@target-uri")) {
    return fail("missing-component", "@authority must be covered", keyid);
  }
  const agentHeaderValue = headers.get(SIGNATURE_HEADERS.signatureAgent);
  let signatureAgent: string | null = null;
  if (agentHeaderValue !== null) {
    const covered = signatureParams.items.find((item) => item.value === "signature-agent");
    if (!covered) return fail("missing-component", "Signature-Agent must be covered", keyid);
    signatureAgent = readSignatureAgent(agentHeaderValue, covered.params.get("key"));
  }

  // Key and signature.
  let url: URL | undefined;
  try {
    url = options.url !== undefined ? new URL(options.url) : undefined;
  } catch {
    return fail("malformed", "Invalid request URL", keyid);
  }
  let base: string;
  try {
    base = signatureBase(signatureParams, {
      url,
      authority: options.authority,
      method: options.method,
      headers,
    });
  } catch (err) {
    const reason = err instanceof UnsupportedComponentError ? "unsupported" : "malformed";
    return fail(reason, (err as Error).message, keyid);
  }

  let jwk: Ed25519PublicJwk | null;
  try {
    jwk = await options.resolveKey(keyid, { signatureAgent });
  } catch {
    jwk = null;
  }
  if (!jwk || !isEd25519PublicJwk(jwk)) return fail("unknown-key", "Unknown keyid", keyid);
  // The key must be the one the keyid names.
  if ((await jwkThumbprint(jwk)) !== keyid) return fail("unknown-key", "keyid mismatch", keyid);

  let valid = false;
  try {
    valid =
      signature.length === 64 &&
      (await crypto.subtle.verify(
        { name: "Ed25519" },
        await importPublicKey(jwk),
        new Uint8Array(signature),
        new TextEncoder().encode(base),
      ));
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad-signature", "Signature does not verify", keyid);

  const botfareKeyId = jwk[BOTFARE_KEY_ID_MEMBER];
  return {
    ok: true,
    keyid,
    label,
    botfareKeyId: typeof botfareKeyId === "string" ? botfareKeyId : null,
    signatureAgent,
    directoryUrl: signatureAgent ? directoryUrlFor(signatureAgent) : null,
    created,
    expires,
    nonce: typeof nonce === "string" ? nonce : null,
    jwk,
  };
}

/** The Signature-Agent URI: legacy sf-string form, or the dictionary member named by `key`. */
function readSignatureAgent(value: string, key: BareItem | undefined): string | null {
  try {
    if (typeof key === "string") {
      const member = parseDictionary(value).get(key);
      return member && !isInnerList(member) && typeof member.value === "string"
        ? member.value
        : null;
    }
    const item = parseItem(value);
    if (typeof item.value === "string") return item.value;
  } catch {
    // Fall through to the dictionary form without a key.
  }
  try {
    const dict = parseDictionary(value);
    if (dict.size === 1) {
      const [member] = dict.values();
      if (member && !isInnerList(member) && typeof member.value === "string") return member.value;
    }
  } catch {
    // Not a dictionary either.
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Directory

/** Validates a directory body; malformed or private entries are dropped. */
export function parseSignatureDirectory(body: unknown): Ed25519PublicJwk[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { keys?: unknown }).keys)) {
    return [];
  }
  return (body as { keys: unknown[] }).keys.filter(isEd25519PublicJwk);
}

export interface DirectoryKeyResolverOptions {
  /** Trusted directory, e.g. `${BOTFARE_URL}${SIGNATURE_DIRECTORY_PATH}`. */
  directoryUrl: string;
  fetch?: typeof fetch;
  /** How long a fetched directory is used; default 60 s. */
  cacheSeconds?: number;
  /** An unknown keyid refetches at most this often; default 5 s (so new keys work quickly). */
  minRefetchSeconds?: number;
}

/**
 * A `resolveKey` for verifySignedRequest that reads keys only from one trusted directory, with a
 * small cache. Never fetches the URI a request names (no SSRF).
 */
export function createDirectoryKeyResolver(
  options: DirectoryKeyResolverOptions,
): (keyid: string) => Promise<Ed25519PublicJwk | null> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const cacheMs = (options.cacheSeconds ?? 60) * 1000;
  const minRefetchMs = (options.minRefetchSeconds ?? 5) * 1000;
  let keys = new Map<string, Ed25519PublicJwk>();
  let fetchedAt = 0;
  let inFlight: Promise<void> | null = null;

  async function load(): Promise<void> {
    const response = await doFetch(options.directoryUrl, {
      headers: { accept: `${SIGNATURE_DIRECTORY_MEDIA_TYPE}, application/json` },
    });
    if (!response.ok) throw new Error(`Directory returned ${response.status}`);
    const next = new Map<string, Ed25519PublicJwk>();
    for (const jwk of parseSignatureDirectory(await response.json())) {
      next.set(await jwkThumbprint(jwk), jwk);
    }
    keys = next;
    fetchedAt = Date.now();
  }

  function refresh(): Promise<void> {
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return async (keyid) => {
    const age = Date.now() - fetchedAt;
    try {
      if (age >= cacheMs || (!keys.has(keyid) && age >= minRefetchMs)) await refresh();
    } catch {
      // Keep serving the last good directory.
    }
    return keys.get(keyid) ?? null;
  };
}

// ---------------------------------------------------------------------------------------------
// Signature base (RFC 9421 section 2.5)

class UnsupportedComponentError extends Error {}

interface BaseContext {
  url?: URL;
  authority?: string;
  method?: string;
  headers: Headers;
}

function signatureBase(signatureParams: InnerList, context: BaseContext): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const component of signatureParams.items) {
    if (typeof component.value !== "string") throw new Error("Component names must be strings");
    const id = serializeItem(component);
    if (seen.has(id)) throw new Error(`Duplicate component ${id}`);
    seen.add(id);
    lines.push(`${id}: ${componentValue(component, context)}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(signatureParams)}`);
  return lines.join("\n");
}

function componentValue(component: Item, context: BaseContext): string {
  const name = component.value as string;
  for (const param of component.params.keys()) {
    if (param !== "key") throw new UnsupportedComponentError(`Unsupported parameter ;${param}`);
  }
  if (name.startsWith("@")) {
    if (component.params.size) throw new UnsupportedComponentError(`Unsupported ${name} params`);
    const { url } = context;
    const need = (): URL => {
      if (!url) throw new UnsupportedComponentError(`${name} needs the request URL`);
      return url;
    };
    switch (name) {
      case "@authority": {
        const authority = context.authority ?? need().host;
        return normalizeAuthority(authority, url?.protocol);
      }
      case "@method":
        if (!context.method) throw new UnsupportedComponentError("@method needs the method");
        return context.method.toUpperCase();
      case "@target-uri":
        return need().href;
      case "@scheme":
        return need().protocol.slice(0, -1);
      case "@path":
        return need().pathname || "/";
      case "@query":
        return need().search || "?";
      case "@request-target":
        return `${need().pathname || "/"}${need().search}`;
      default:
        throw new UnsupportedComponentError(`Unsupported component ${name}`);
    }
  }
  if (name !== name.toLowerCase()) throw new Error(`Header names must be lowercase: ${name}`);
  const raw = context.headers.get(name);
  if (raw === null) throw new Error(`Covered header ${name} is missing`);
  const key = component.params.get("key");
  if (key === undefined) return raw.trim();
  if (typeof key !== "string") throw new Error("key must be a string");
  const member = parseDictionary(raw).get(key);
  if (!member) throw new Error(`Header ${name} has no member ${key}`);
  return isInnerList(member) ? serializeInnerList(member) : serializeItem(member);
}

/** Lowercase host[:port], dropping the scheme's default port. */
function normalizeAuthority(authority: string, protocol?: string): string {
  const lower = authority.trim().toLowerCase();
  if (
    (protocol === "https:" && lower.endsWith(":443")) ||
    (protocol === "http:" && lower.endsWith(":80"))
  ) {
    return lower.slice(0, lower.lastIndexOf(":"));
  }
  return lower;
}

// ---------------------------------------------------------------------------------------------
// RFC 8941 structured fields (the subset HTTP Message Signatures needs)

class Token {
  constructor(readonly value: string) {}
}
type BareItem = string | number | boolean | Uint8Array | Token;
type Params = Map<string, BareItem>;
interface Item {
  value: BareItem;
  params: Params;
}
interface InnerList {
  items: Item[];
  params: Params;
}
type Dictionary = Map<string, Item | InnerList>;

function isInnerList(member: Item | InnerList): member is InnerList {
  return "items" in member;
}

function isInteger(value: BareItem | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

class Parser {
  pos = 0;
  constructor(readonly input: string) {}

  get done(): boolean {
    return this.pos >= this.input.length;
  }
  peek(): string {
    return this.input[this.pos] ?? "";
  }
  error(message: string): never {
    throw new Error(`${message} at ${this.pos}`);
  }
  skipSP(): void {
    while (this.peek() === " ") this.pos++;
  }
  skipOWS(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  key(): string {
    const match = /^[a-z*][a-z0-9_\-.*]*/.exec(this.input.slice(this.pos));
    if (!match) this.error("Expected key");
    this.pos += match[0].length;
    return match[0];
  }

  params(): Params {
    const params: Params = new Map();
    while (this.peek() === ";") {
      this.pos++;
      this.skipSP();
      const key = this.key();
      let value: BareItem = true;
      if (this.peek() === "=") {
        this.pos++;
        value = this.bareItem();
      }
      params.set(key, value);
    }
    return params;
  }

  bareItem(): BareItem {
    const c = this.peek();
    if (c === "-" || /[0-9]/.test(c)) return this.number();
    if (c === '"') return this.string();
    if (c === ":") return this.bytes();
    if (c === "?") return this.boolean();
    if (c === "*" || /[A-Za-z]/.test(c)) return this.token();
    return this.error("Unexpected character");
  }

  number(): number {
    const match = /^-?[0-9]{1,15}(\.[0-9]{1,3})?/.exec(this.input.slice(this.pos));
    if (!match) this.error("Bad number");
    this.pos += match[0].length;
    return Number(match[0]);
  }

  string(): string {
    this.pos++; // opening quote
    let out = "";
    while (!this.done) {
      const c = this.input[this.pos++] as string;
      if (c === "\\") {
        const next = this.input[this.pos++];
        if (next !== '"' && next !== "\\") this.error("Bad escape");
        out += next;
      } else if (c === '"') {
        return out;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) this.error("Bad string character");
        out += c;
      }
    }
    return this.error("Unterminated string");
  }

  token(): Token {
    const match = /^[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/.exec(this.input.slice(this.pos));
    if (!match) this.error("Bad token");
    this.pos += match[0].length;
    return new Token(match[0]);
  }

  bytes(): Uint8Array {
    this.pos++;
    const end = this.input.indexOf(":", this.pos);
    if (end < 0) this.error("Unterminated byte sequence");
    const b64 = this.input.slice(this.pos, end);
    if (!/^[A-Za-z0-9+/=]*$/.test(b64)) this.error("Bad byte sequence");
    this.pos = end + 1;
    return base64ToBytes(b64);
  }

  boolean(): boolean {
    this.pos++;
    const c = this.input[this.pos++];
    if (c === "1") return true;
    if (c === "0") return false;
    return this.error("Bad boolean");
  }

  item(): Item {
    const value = this.bareItem();
    return { value, params: this.params() };
  }

  innerList(): InnerList {
    this.pos++; // (
    const items: Item[] = [];
    while (!this.done) {
      this.skipSP();
      if (this.peek() === ")") {
        this.pos++;
        return { items, params: this.params() };
      }
      items.push(this.item());
      const c = this.peek();
      if (c !== " " && c !== ")") this.error("Expected space or )");
    }
    return this.error("Unterminated inner list");
  }

  member(): Item | InnerList {
    return this.peek() === "(" ? this.innerList() : this.item();
  }
}

function parseDictionary(input: string): Dictionary {
  const parser = new Parser(input);
  const dict: Dictionary = new Map();
  parser.skipSP();
  while (!parser.done) {
    const key = parser.key();
    let member: Item | InnerList;
    if (parser.peek() === "=") {
      parser.pos++;
      member = parser.member();
    } else {
      member = { value: true, params: parser.params() };
    }
    dict.set(key, member);
    parser.skipOWS();
    if (parser.done) break;
    if (parser.peek() !== ",") parser.error("Expected ,");
    parser.pos++;
    parser.skipOWS();
    if (parser.done) parser.error("Trailing comma");
  }
  return dict;
}

function parseItem(input: string): Item {
  const parser = new Parser(input);
  parser.skipSP();
  const item = parser.item();
  parser.skipSP();
  if (!parser.done) parser.error("Trailing characters");
  return item;
}

function serializeString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new TypeError("sf-string must be printable ASCII");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function serializeBareItem(value: BareItem): string {
  if (typeof value === "string") return serializeString(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "?1" : "?0";
  if (value instanceof Uint8Array) return `:${bytesToBase64(value)}:`;
  return value.value;
}

function serializeParams(params: Params): string {
  let out = "";
  for (const [key, value] of params) {
    out += value === true ? `;${key}` : `;${key}=${serializeBareItem(value)}`;
  }
  return out;
}

function serializeItem(item: Item): string {
  return serializeBareItem(item.value) + serializeParams(item.params);
}

function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(" ")})${serializeParams(list.params)}`;
}

// ---------------------------------------------------------------------------------------------
// Bytes, base64 and headers (no Buffer)

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Fetch Headers from a Headers, a Node/Express header object, or entries. */
function toHeaders(input: HeadersLike | undefined): Headers {
  if (!input) return new Headers();
  if (input instanceof Headers) return new Headers(input);
  const headers = new Headers();
  const entries: Iterable<[string, unknown]> =
    Symbol.iterator in input ? (input as Iterable<[string, string]>) : Object.entries(input);
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, String(v));
    else headers.append(name, String(value));
  }
  return headers;
}
