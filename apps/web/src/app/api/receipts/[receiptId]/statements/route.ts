import { handleReceiptStatements } from "../../../../../lib/server/receipt-statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * receiptStatementsPath(id): the signed payment, delivery and refund statements of a receipt
 * (ReceiptStatements). Public and rate-limited; 404 for an unknown receipt.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ receiptId: string }> },
): Promise<Response> {
  const { receiptId } = await params;
  return handleReceiptStatements(request, receiptId);
}
