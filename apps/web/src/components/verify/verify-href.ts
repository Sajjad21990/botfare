/** Links to the public /verify page (no crypto imports, so any component can use it). */
import { IdPrefix } from "@botfare/contracts";

const RECEIPT_ID = new RegExp(`^${IdPrefix.receipt}_[A-Za-z0-9]{4,64}$`);

export function isReceiptId(value: string): boolean {
  return RECEIPT_ID.test(value);
}

/** Where a receipt can be checked by anyone. */
export function verifyHref(receiptId: string): string {
  return `/verify?receipt=${encodeURIComponent(receiptId)}`;
}
