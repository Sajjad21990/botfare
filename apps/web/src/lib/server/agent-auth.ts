import { isEd25519PublicJwk, verifySignedRequest } from "@botfare/contracts/web-bot-auth";
import { type AgentKey, type DbOrTx, getAgentKeyById } from "@botfare/core";
import { findAgentByThumbprint } from "./agent-directory";
import { jsonError } from "./http";

/**
 * Authentication for the agent API (`/api/agent/*`): the request's own Web Bot Auth HTTP Message
 * Signature (RFC 9421, Ed25519), the same one the SDK puts on every request it sends.
 *
 * - The key comes from BotFare's database: the signature's `keyid` (JWK thumbprint) must name an
 *   active agent key. The Signature-Agent URL a request carries is never fetched or trusted.
 * - The signed `@authority` must be BotFare's own host (BOTFARE_URL / RENDER_EXTERNAL_URL, or the
 *   Host header when neither is set, i.e. local dev), so a signature an agent sent to a publisher
 *   cannot be replayed here.
 * - `created`/`expires` are checked (at most 5 minutes of validity, 30 s of clock skew) and each
 *   nonce is accepted once while its signature is valid.
 */

export type AgentAuthResult = { ok: true; key: AgentKey } | { ok: false; response: Response };

export interface AgentAuthOptions {
  /** Unix seconds (tests). */
  now?: number;
}

const MAX_VALIDITY_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;

/** Nonces seen while their signature is still valid: nonce -> expires (Unix seconds). */
const globalForNonces = globalThis as typeof globalThis & {
  __botfareAgentNonces?: Map<string, number>;
};

function seenNonces(): Map<string, number> {
  globalForNonces.__botfareAgentNonces ??= new Map();
  return globalForNonces.__botfareAgentNonces;
}

function unauthorized(message: string): AgentAuthResult {
  return {
    ok: false,
    response: jsonError(401, "unauthorized", message, {
      "cache-control": "no-store",
      "www-authenticate": 'Signature realm="botfare-agent-api"',
    }),
  };
}

/** Lowercase host[:port] of a URL, or null. */
function hostOf(value: string | undefined | null): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The authorities a signature for BotFare's own API may cover. */
export function botfareAuthorities(request: Request): string[] {
  const configured = [process.env.BOTFARE_URL, process.env.RENDER_EXTERNAL_URL]
    .map(hostOf)
    .filter((host): host is string => host !== null);
  if (configured.length > 0) return [...new Set(configured)];
  // No public URL configured (local dev): the Host this request reached.
  const host = request.headers.get("host")?.trim().toLowerCase() || hostOf(request.url);
  return host ? [host] : [];
}

/** Verifies the request's signature and returns the active agent key that made it. */
export async function authenticateAgent(
  db: DbOrTx,
  request: Request,
  options: AgentAuthOptions = {},
): Promise<AgentAuthResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const authorities = botfareAuthorities(request);
  if (authorities.length === 0) return unauthorized("Cannot determine this server's host");

  let key: AgentKey | null = null;
  let revoked = false;
  const resolveKey = async (keyid: string) => {
    const entry = await findAgentByThumbprint(db, keyid);
    if (!entry) return null;
    if (entry.status !== "active") {
      revoked = true;
      return null;
    }
    const found = await getAgentKeyById(db, entry.keyId);
    if (found?.status !== "active" || !isEd25519PublicJwk(found.publicJwk)) return null;
    key = found;
    return found.publicJwk;
  };

  let failure = "";
  for (const authority of authorities) {
    const result = await verifySignedRequest({
      url: request.url,
      authority,
      method: request.method,
      headers: request.headers,
      resolveKey,
      now,
      maxValiditySeconds: MAX_VALIDITY_SECONDS,
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
    });
    if (result.ok) {
      const signedKey = key as AgentKey | null;
      if (!signedKey) return unauthorized("Unknown agent key");
      if (result.nonce) {
        const nonces = seenNonces();
        for (const [nonce, expires] of nonces) if (expires < now) nonces.delete(nonce);
        if (nonces.has(result.nonce)) {
          return unauthorized("This signature was already used; sign each request afresh");
        }
        nonces.set(result.nonce, result.expires);
      }
      return { ok: true, key: signedKey };
    }
    if (revoked) return unauthorized("This agent key has been revoked");
    failure = describeFailure(result.reason, result.message);
    // Only a signature mismatch depends on the authority; anything else fails for every host.
    if (result.reason !== "bad-signature") break;
  }
  return unauthorized(failure);
}

function describeFailure(reason: string, message: string): string {
  switch (reason) {
    case "missing":
      return "Sign this request with your BotFare agent key (Web Bot Auth HTTP Message Signature); the SDK and the MCP server do this for you";
    case "unknown-key":
      return "The signature's keyid is not an active BotFare agent key";
    case "expired":
      return "The signature has expired; sign each request afresh";
    case "not-yet-valid":
      return "The signature's created time is in the future; check this machine's clock";
    case "bad-signature":
      return "The signature does not verify for this server; sign requests for the BOTFARE_URL host";
    default:
      return `Invalid request signature (${reason}): ${message}`;
  }
}
