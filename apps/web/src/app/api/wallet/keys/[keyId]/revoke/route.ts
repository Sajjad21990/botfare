import { isLockedDemoKey } from "@botfare/contracts";
import { getAgentKeyById, revokeAgentKey } from "@botfare/core";
import { getDb } from "../../../../../../lib/server/db";
import { jsonError } from "../../../../../../lib/server/http";
import { judgeModeRefusal } from "../../../../../../lib/server/judge";
import { requireApiUser } from "../../../../../../lib/server/session";
import { toWalletAgentKey } from "../../../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revokes one of the signed-in user's agent keys. Idempotent; another user's key (or an unknown
 * ID) is a 404 and is left untouched. Payments signed with a revoked key fail verification.
 * Judges cannot revoke the seeded demo keys that the demo agent and seed traffic use.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ keyId: string }> },
): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const { keyId } = await params;
  const db = getDb();
  const existing = await getAgentKeyById(db, keyId);
  if (!existing || existing.ownerUserId !== auth.user.id) {
    return jsonError(404, "not_found", "Agent key not found");
  }
  if (isLockedDemoKey(auth.user.email, existing.name)) {
    return judgeModeRefusal("The demo agent pays with this key.");
  }
  const key = await revokeAgentKey(db, { keyId, ownerUserId: auth.user.id });
  if (!key) return jsonError(404, "not_found", "Agent key not found");
  return Response.json({ key: toWalletAgentKey(key, 0, auth.user.email) });
}
