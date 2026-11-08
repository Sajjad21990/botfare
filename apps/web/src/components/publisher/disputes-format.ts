import type { DisputeReason, DisputeStatus } from "@botfare/contracts/fare";
import type { DisputeView } from "./disputes-types";

/** Labels shared by the publisher's Disputes page and the owner's wallet (browser-safe). */

const REASONS: Record<DisputeReason, string> = {
  not_as_described: "Not as described",
  stub_or_paywall: "Stub or paywall",
  error_page: "Error page",
  truncated: "Truncated",
  unrelated: "Unrelated content",
  other: "Other",
};

export function reasonLabel(reason: DisputeReason): string {
  return REASONS[reason] ?? reason;
}

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

/** Status label and badge style; `viewer` picks whose words the pending state uses. */
export function statusMeta(
  status: DisputeStatus,
  viewer: "publisher" | "owner",
): { label: string; variant: BadgeVariant } {
  switch (status) {
    case "pending_publisher":
      return {
        label: viewer === "publisher" ? "Needs your review" : "With the publisher",
        variant: viewer === "publisher" ? "default" : "outline",
      };
    case "refunded":
      return { label: "Refunded", variant: "secondary" };
    case "denied":
      return { label: "Denied", variant: "outline" };
    case "rejected_by_publisher":
      return {
        label: viewer === "publisher" ? "You declined" : "Declined by publisher",
        variant: "outline",
      };
    case "invalid":
      return { label: "Invalid", variant: "destructive" };
  }
}

/** Who decided, in a few words ("by the AI judge"), or null while pending. */
export function decidedByLabel(
  dispute: Pick<DisputeView, "decidedBy" | "status">,
  viewer: "publisher" | "owner",
): string | null {
  if (dispute.status === "pending_publisher") return null;
  switch (dispute.decidedBy) {
    case "ai":
      return "by the AI judge";
    case "publisher":
      return viewer === "publisher" ? "by you" : "by the publisher";
    case "system":
      return "automatically";
    default:
      return null;
  }
}

export function decisionLabel(decision: "refund" | "deny" | "unsure"): string {
  return decision === "refund" ? "Refund" : decision === "deny" ? "Deny" : "Unsure";
}

export function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** 3 → "3¢", 150 → "$1.50". */
export function formatFare(cents: number): string {
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`;
}
