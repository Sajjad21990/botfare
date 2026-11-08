import { handleFacilitatorCall } from "../../../../lib/server/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** x402 verify: checks a payment without moving money. Site auth required. */
export function POST(request: Request): Promise<Response> {
  return handleFacilitatorCall(request, "verify");
}
