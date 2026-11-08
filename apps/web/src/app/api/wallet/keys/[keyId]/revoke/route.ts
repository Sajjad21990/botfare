import { revokeAgentKey } from "@botfare/core";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError } from "../../../../../../lib/server/http";
import { requireApiUser } from "../../../../../../lib/server/session";
import { toWalletAgentKey } from "../../../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revokes one of the signed-in user's agent keys. Idempotent; another user's key (or an unknown
 * ID) is a 404 and is left untouched. Payments signed with a revoked key fail verification.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ keyId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { keyId } = await params;
  const key = await revokeAgentKey(getDb(), { keyId, ownerUserId: auth.user.id });
  if (!key) return jsonError(404, "not_found", "Agent key not found");
  return Response.json({ key: toWalletAgentKey(key) });
}
