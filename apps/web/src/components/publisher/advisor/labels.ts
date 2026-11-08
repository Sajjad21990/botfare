import type { DeclineCategory } from "@botfare/contracts/fare";

/** Decline categories in words, for the dashboard and analytics. */
export const DECLINE_CATEGORY_LABEL: Record<DeclineCategory, string> = {
  too_expensive: "Too expensive",
  over_budget: "Over budget",
  low_quality_preview: "Weak preview",
  irrelevant: "Not relevant",
  already_have: "Already had it",
  other: "Other",
};
