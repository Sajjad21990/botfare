import { handleOfferTelemetry } from "../../../../lib/server/fare-advisor-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Batched "offer shown" events (402s) from a site's middleware; site Basic auth. */
export function POST(request: Request): Promise<Response> {
  return handleOfferTelemetry(request);
}
