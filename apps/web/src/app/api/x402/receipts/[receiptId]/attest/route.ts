import { handleAttest } from "../../../../../../lib/server/fare-court-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fare Court proof of delivery: the paid site attests the Content-Digest of the body it delivered
 * for one of its receipts (site Basic auth, body receiptAttestationSchema).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ receiptId: string }> },
): Promise<Response> {
  const { receiptId } = await params;
  return handleAttest(request, receiptId);
}
