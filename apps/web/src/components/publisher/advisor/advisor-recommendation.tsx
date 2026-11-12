"use client";

import {
  ArrowRight,
  Check,
  Eye,
  Gavel,
  Loader2,
  Quote,
  ShieldCheck,
  Tag,
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
import { withoutRevenueClaims } from "./display-text";
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

/**
 * A plain headline for when the AI's own one was only a revenue claim, or blank (the server blanks
 * a headline that states numbers not in the data).
 */
function fallbackHeadline(rec: AdvisorRecommendationView): string {
  switch (rec.kind) {
    case "price":
      return rec.suggestedPriceCents === undefined
        ? "Review this price"
        : `Try ${formatPrice(rec.suggestedPriceCents)} instead of ${formatPrice(rec.currentPriceCents)}`;
    case "audience":
      return rec.suggestedAudience
        ? `Charge ${AUDIENCE_LABEL[rec.suggestedAudience]}`
        : "Review who pays";
    case "preview":
      return "Improve the free preview";
    case "keep":
      return "Keep this price";
  }
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

const KIND_ICON = {
  price: Tag,
  preview: Eye,
  audience: Users,
  keep: ShieldCheck,
} satisfies Record<AdvisorRecommendationView["kind"], unknown>;

/** The kind of advice as a badge with an icon, so the list scans without reading. */
function KindBadge({ kind }: { kind: AdvisorRecommendationView["kind"] }) {
  const Icon = KIND_ICON[kind];
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 gap-1 rounded-md border-[1.5px] px-2 font-semibold",
        kind === "price" && "border-foreground bg-brand text-brand-foreground",
        kind === "preview" && "border-foreground bg-ticket text-ticket-foreground",
        kind === "audience" && "border-foreground bg-secondary text-secondary-foreground",
        kind === "keep" && "border-success text-success",
      )}
    >
      <Icon aria-hidden />
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/** "50¢ → 20¢" as a printed ticket: the old price stamped out, the new one big in ink. */
function PriceTicket({ before, after }: { before: number; after: number }) {
  return (
    <div
      className="inline-flex shrink-0 items-center gap-2 self-start rounded-md border-[1.5px] border-foreground bg-ticket px-3 py-1.5 text-ticket-foreground shadow-[3px_3px_0_var(--foreground)]"
      role="img"
      aria-label={`Price from ${formatPrice(before)} to ${formatPrice(after)}`}
    >
      <span className="text-base font-semibold tabular-nums text-stamp line-through decoration-stamp decoration-2">
        {formatPrice(before)}
      </span>
      <ArrowRight className="size-4" aria-hidden />
      <span className="text-3xl leading-none font-bold tracking-tight tabular-nums">
        {formatPrice(after)}
      </span>
    </div>
  );
}

/** Offers as the full width, paid and declined as segments; the legend carries the numbers. */
function EvidenceFunnel({ evidence }: { evidence: AdvisorRecommendationView["evidence"] }) {
  const top = Math.max(evidence.offers, evidence.paid + evidence.declined, 1);
  const pct = (n: number) => Math.min(100, (100 * n) / top);
  const noReply = Math.max(0, evidence.offers - evidence.paid - evidence.declined);
  const bought =
    evidence.offers > 0 ? `${Math.round((100 * evidence.paid) / evidence.offers)}% bought` : null;
  return (
    <div className="space-y-1.5">
      <div
        className="flex h-3 w-full overflow-hidden rounded-full border-[1.5px] border-foreground bg-muted"
        aria-hidden
      >
        <div className="h-full bg-success" style={{ width: `${pct(evidence.paid)}%` }} />
        <div className="h-full bg-stamp" style={{ width: `${pct(evidence.declined)}%` }} />
      </div>
      <ul
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
        aria-label="How agents answered this offer"
      >
        <li className="font-medium text-foreground tabular-nums">
          {formatCount(evidence.offers)} offers
        </li>
        <li className="flex items-center gap-1 tabular-nums">
          <span className="size-2 rounded-full bg-success" aria-hidden />
          <span className="font-medium text-foreground">{formatCount(evidence.paid)}</span> paid
        </li>
        <li className="flex items-center gap-1 tabular-nums">
          <span className="size-2 rounded-full bg-stamp" aria-hidden />
          <span className="font-medium text-foreground">{formatCount(evidence.declined)}</span>{" "}
          declined
        </li>
        {noReply > 0 && (
          <li className="flex items-center gap-1 tabular-nums">
            <span
              className="size-2 rounded-full border border-muted-foreground/40 bg-muted"
              aria-hidden
            />
            {formatCount(noReply)} no reply
          </li>
        )}
        {evidence.cited > 0 && (
          <li>
            <Badge variant="outline" className="gap-1 font-normal tabular-nums">
              <Quote aria-hidden />
              {formatCount(evidence.cited)} cited
            </Badge>
          </li>
        )}
        {evidence.disputed > 0 && (
          <li>
            <Badge variant="destructive" className="gap-1 font-normal tabular-nums">
              <Gavel aria-hidden />
              {formatCount(evidence.disputed)} disputed
            </Badge>
          </li>
        )}
        {bought && <li className="ml-auto tabular-nums">{bought}</li>}
      </ul>
    </div>
  );
}

/** Decline reasons as bars sized by count, largest first; the text and count stay readable. */
export function ReasonBars({
  reasons,
  label = "Why agents declined",
}: {
  reasons: { reason: string; count: number }[];
  label?: string;
}) {
  if (reasons.length === 0) return null;
  const sorted = [...reasons].sort((a, b) => b.count - a.count);
  const max = Math.max(...sorted.map((r) => r.count), 1);
  return (
    <ol className="space-y-1" aria-label={label}>
      {sorted.map((reason) => (
        <li
          key={reason.reason}
          className="relative flex items-start gap-2 overflow-hidden rounded-md border px-2 py-1 text-xs"
        >
          <span
            className="absolute inset-y-0 left-0 bg-stamp/12 dark:bg-stamp/25"
            style={{ width: `${(100 * reason.count) / max}%` }}
            aria-hidden
          />
          <span className="relative min-w-0 flex-1 break-words">{reason.reason}</span>
          <span className="relative shrink-0 font-semibold tabular-nums">×{reason.count}</span>
        </li>
      ))}
    </ol>
  );
}

/** The AI's reasoning, kept quiet: three lines, then More. */
function Rationale({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return (
    <div className="text-sm text-muted-foreground">
      <p className={cn(!open && long && "line-clamp-3")}>{text}</p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-0.5 text-xs font-medium text-foreground underline-offset-2 hover:underline"
        >
          {open ? "Less" : "More"}
        </button>
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
  // Revenue figures come only from BotFare's estimate, never from the AI's sentences.
  const headline = withoutRevenueClaims(rec.headline) || fallbackHeadline(rec);
  const rationale = withoutRevenueClaims(rec.rationale);

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

  const priceChange =
    rec.kind === "price" && rec.suggestedPriceCents !== undefined
      ? { before: rec.currentPriceCents, after: rec.suggestedPriceCents }
      : null;

  return (
    <li className="space-y-3 rounded-lg border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-start gap-3">
        {priceChange && <PriceTicket before={priceChange.before} after={priceChange.after} />}
        <div className="min-w-0 flex-1 basis-48 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={rec.kind} />
            <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {rec.method !== "GET" && `${rec.method} `}
              {rec.pattern}
            </code>
          </div>
          <p className="font-medium leading-snug">{headline}</p>
          {(rec.kind === "price" || rec.kind === "preview") && (
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium tabular-nums",
                delta > 0
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : delta < 0
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "bg-muted text-muted-foreground",
              )}
              title="Worked out by BotFare from this rule's own offers, purchases and declines, not by the AI"
            >
              <Trend className="size-3.5" aria-hidden />
              Estimated change: {formatDelta(delta)} a week
            </div>
          )}
        </div>
      </div>

      <EvidenceFunnel evidence={rec.evidence} />

      <ReasonBars reasons={rec.evidence.topReasons} />

      {rec.previewAdvice && (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-sm">
          <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p>{rec.previewAdvice}</p>
        </div>
      )}

      {rationale && <Rationale text={rationale} />}

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
                  BotFare estimate for this rule: {formatPrice(rec.projection.currentWeeklyCents)} →{" "}
                  {formatPrice(rec.projection.projectedWeeklyCents)} a week, {formatDelta(delta)}.
                  Worked out from your own offers and purchases; real AI agents decide.
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
