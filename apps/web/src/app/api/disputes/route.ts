import { handleDispute } from "../../../lib/server/fare-court-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The AI judge can take up to two model calls. */
export const maxDuration = 60;

/**
 * Fare Court: an agent disputes one of its receipts, signed with its key (Web Bot Auth), with the
 * exact bytes it received (disputeRequestSchema). Answers with the DisputeOutcome.
 */
export function POST(request: Request): Promise<Response> {
  return handleDispute(request);
}
