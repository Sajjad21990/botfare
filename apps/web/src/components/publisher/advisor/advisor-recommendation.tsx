"use client";

import {
  ArrowRight,
  Check,
  Eye,
  Loader2,
  Quote,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, errorText } from "../api";
import { formatCount, formatPrice } from "../format";
import type { SiteView } from "../types";
import type { AdvisorApplyResponse, AdvisorRecommendationView } from "./types";

const KIND_LABEL: Record<AdvisorRecommendationView["kind"], string> = {
  price: "Price",
  preview: "Preview",
  audience: "Audience",
  keep: "Keep",
};

const AUDIENCE_LABEL = { agents: "AI agents only", everyone: "everyone" } as const;

/** +39¢, −$1.20, or ±0¢. */
export function formatDelta(cents: number): string {
  if (cents === 0) return "±0¢";
  return `${cents > 0 ? "+" : "−"}${formatPrice(Math.abs(cents))}`;
}

/** What Apply would change, or null for advice that needs the publisher's own edit. */
function changeOf(rec: AdvisorRecommendationView) {
  if (rec.kind === "price" && rec.suggestedPriceCents !== undefined) {
    return {
      label: "Price per request",
      before: formatPrice(rec.currentPriceCents),
      after: formatPrice(rec.suggestedPriceCents),
      body: { priceCents: rec.suggestedPriceCents },
    };
  }
  if (rec.kind === "audience" && rec.suggestedAudience) {
    return {
      label: "Who pays",
      before:
        rec.suggestedAudience === "everyone" ? AUDIENCE_LABEL.agents : AUDIENCE_LABEL.everyone,
      after: AUDIENCE_LABEL[rec.suggestedAudience],
      body: { audience: rec.suggestedAudience },
    };
  }
  return null;
}

function Evidence({ rec }: { rec: AdvisorRecommendationView }) {
  const { evidence } = rec;
  const items: [string, number][] = [
    ["offers", evidence.offers],
    ["paid", evidence.paid],
    ["declined", evidence.declined],
    ["cited", evidence.cited],
    ["disputed", evidence.disputed],
  ];
  return (
    <div className="space-y-2">
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1">
            <dd className="font-medium text-foreground tabular-nums">{formatCount(value)}</dd>
            <dt>{label}</dt>
          </div>
        ))}
      </dl>
      {evidence.topReasons.length > 0 && (
        <ul className="space-y-1">
          {evidence.topReasons.map((reason) => (
            <li
              key={reason.reason}
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <Quote className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">
                {reason.reason}
                <span className="ml-1 tabular-nums">×{reason.count}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One checked AI recommendation, with Apply (and a confirmation) when it is a rule change. */
export function RecommendationItem({
  siteId,
  rec,
  onApplied,
}: {
  siteId: string;
  rec: AdvisorRecommendationView;
  onApplied: (site: SiteView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const change = changeOf(rec);
  const delta = rec.projectedWeeklyRevenueDeltaCents;
  const Trend = delta < 0 ? TrendingDown : TrendingUp;

  async function apply() {
    if (!change) return;
    setApplying(true);
    try {
      const result = await api<AdvisorApplyResponse>("POST", "/api/publisher/advisor/apply", {
        siteId,
        pattern: rec.pattern,
        method: rec.method,
        ...change.body,
      });
      setApplied(true);
      setConfirming(false);
      toast.success(
        result.changed
          ? `${rec.pattern}: ${change.label.toLowerCase()} is now ${change.after}`
          : `${rec.pattern} already had that setting`,
        { description: "Your middleware picks up the change within 30 seconds." },
      );
      onApplied(result.site);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <li className="space-y-3 rounded-lg border p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{KIND_LABEL[rec.kind]}</Badge>
            <code className="truncate font-mono text-xs text-muted-foreground">
              {rec.method !== "GET" && `${rec.method} `}
              {rec.pattern}
            </code>
          </div>
          <p className="font-medium leading-snug">{rec.headline}</p>
        </div>
        {(rec.kind === "price" || rec.kind === "preview") && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium tabular-nums",
              delta > 0
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : delta < 0
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "bg-muted text-muted-foreground",
            )}
            title="BotFare's estimate from this rule's funnel, not the AI's"
          >
            <Trend className="size-3.5" />
            {formatDelta(delta)} / week
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground">{rec.rationale}</p>

      {rec.previewAdvice && (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-sm">
          <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>{rec.previewAdvice}</p>
        </div>
      )}

      <Evidence rec={rec} />

      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        {change ? (
          <Button
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={applied}
            variant={applied ? "outline" : "default"}
          >
            {applied ? <Check /> : rec.kind === "audience" ? <Users /> : <ArrowRight />}
            {applied ? "Applied" : `Apply: ${change.after}`}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {rec.kind === "preview"
              ? "Update the page's free title and preview, or the rule's description."
              : "No change needed."}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          Confidence {Math.round(rec.confidence * 100)}%
        </span>
      </div>

      {change && (
        <Dialog open={confirming} onOpenChange={(open) => !applying && setConfirming(open)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Apply this change?</DialogTitle>
              <DialogDescription>
                Updates the pricing rule for <code className="font-mono">{rec.pattern}</code>. You
                can change it back any time in the pricing editor.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">{change.label}</div>
                <div className="mt-1 flex items-center gap-3 text-lg font-semibold tabular-nums">
                  <span className="text-muted-foreground line-through decoration-1">
                    {change.before}
                  </span>
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <span>{change.after}</span>
                </div>
              </div>
              {rec.kind === "price" && (
                <p className="text-xs text-muted-foreground">
                  Projected weekly revenue for this rule:{" "}
                  {formatPrice(rec.projection.currentWeeklyCents)} →{" "}
                  {formatPrice(rec.projection.projectedWeeklyCents)} ({formatDelta(delta)}). An
                  estimate from your own funnel; real agents decide.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={applying}>
                Cancel
              </Button>
              <Button onClick={apply} disabled={applying}>
                {applying && <Loader2 className="animate-spin" />}
                Apply {change.after}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </li>
  );
}
