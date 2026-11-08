import { handleRefund } from "../../../../lib/server/refund";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refunds one of the authenticated site's receipts: `{ transaction: "rcpt_..." }`. */
export function POST(request: Request): Promise<Response> {
  return handleRefund(request);
}
