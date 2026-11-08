import { getDb } from "../../../../lib/server/db";
import { requireApiUser } from "../../../../lib/server/session";
import { getWalletView } from "../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in agent owner's wallet: balance, today's spend, top-ups, keys and receipts. */
export async function GET(): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const view = await getWalletView(getDb(), auth.user.id);
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
