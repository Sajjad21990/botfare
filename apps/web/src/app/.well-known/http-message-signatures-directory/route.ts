import { SIGNATURE_DIRECTORY_MEDIA_TYPE } from "@botfare/contracts/web-bot-auth";
import { buildSignatureDirectory } from "../../../lib/server/agent-directory";
import { getDb } from "../../../lib/server/db";
import { jsonError } from "../../../lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verifiers cache the directory this long, so a revoked key stops verifying within a minute. */
const MAX_AGE_SECONDS = 60;

/**
 * Web Bot Auth key directory (SIGNATURE_DIRECTORY_PATH): a JWKS of every active BotFare agent
 * key. Each JWK has `kid` = its RFC 7638 thumbprint (the `keyid` in agent request signatures)
 * and `botfare_key_id` = the agent key ID (`ak_...`). Public; no secrets.
 *
 * Not signed: draft-meunier-http-message-signatures-directory asks the directory host to sign the
 * response once per listed key (tag "http-message-signatures-directory") as proof it holds each
 * private key. BotFare only stores agents' public keys, so it cannot produce those signatures;
 * verifiers that trust BotFare's origin over HTTPS (packages/express) do not need them.
 */
export async function GET(): Promise<Response> {
  let directory: Awaited<ReturnType<typeof buildSignatureDirectory>>;
  try {
    directory = await buildSignatureDirectory(getDb());
  } catch {
    return jsonError(503, "unavailable", "The key directory is temporarily unavailable", {
      "cache-control": "no-store",
    });
  }
  return new Response(JSON.stringify(directory), {
    headers: {
      "content-type": SIGNATURE_DIRECTORY_MEDIA_TYPE,
      "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
      "access-control-allow-origin": "*",
    },
  });
}
