import { and, desc, eq, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { type Receipt, receipts } from "../schema";

export interface ListReceiptsInput {
  /** Agent owner whose wallet paid. */
  ownerUserId?: string;
  siteId?: string;
  agentKeyId?: string;
  /** Default 50, at most 500. */
  limit?: number;
}

/** Newest receipts first, filtered by every field given (no filter = all receipts). */
export function listReceipts(db: DbOrTx, input: ListReceiptsInput = {}): Promise<Receipt[]> {
  const filters: SQL[] = [];
  if (input.ownerUserId) filters.push(eq(receipts.ownerUserId, input.ownerUserId));
  if (input.siteId) filters.push(eq(receipts.siteId, input.siteId));
  if (input.agentKeyId) filters.push(eq(receipts.agentKeyId, input.agentKeyId));
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 500);
  return db
    .select()
    .from(receipts)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(receipts.createdAt), desc(receipts.id))
    .limit(limit);
}

export async function getReceipt(db: DbOrTx, receiptId: string): Promise<Receipt | null> {
  const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  return receipt ?? null;
}
