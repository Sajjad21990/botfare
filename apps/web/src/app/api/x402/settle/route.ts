import { handleFacilitatorCall } from "../../../../lib/server/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 settle: charges the agent's wallet and writes a receipt. Site auth required. */
export function POST(request: Request): Promise<Response> {
  return handleFacilitatorCall(request, "settle");
}
