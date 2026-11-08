import { getFacilitator } from "../../../../lib/server/facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 discovery: the schemes and networks this facilitator settles. No auth. */
export function GET(): Response {
  return Response.json(getFacilitator().getSupported());
}
