import { findAgentByThumbprint, isThumbprint } from "../../../../lib/server/agent-directory";
import { getDb } from "../../../../lib/server/db";
import { jsonError } from "../../../../lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public lookup of a signing key by its JWK thumbprint (the `keyid` of a Web Bot Auth signature):
 * `{ keyId, status }`, including revoked keys. No owner, budget or other private fields.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ thumbprint: string }> },
): Promise<Response> {
  const { thumbprint } = await params;
  if (!isThumbprint(thumbprint)) {
    return jsonError(400, "invalid_thumbprint", "Expected a 43-character base64url JWK thumbprint");
  }
  const agent = await findAgentByThumbprint(getDb(), thumbprint);
  if (!agent) return jsonError(404, "not_found", "No agent key has this thumbprint");
  return Response.json(agent, {
    headers: { "cache-control": "public, max-age=10", "access-control-allow-origin": "*" },
  });
}
