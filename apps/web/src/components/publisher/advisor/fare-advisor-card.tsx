"use client";

import type { DeclineCategory } from "@botfare/contracts/fare";
import {
  AlertCircle,
  ChevronRight,
  KeyRound,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, errorText } from "../api";
import { formatCount, formatPrice } from "../format";
import type { SiteView } from "../types";
import { ReasonBars, RecommendationItem } from "./advisor-recommendation";
import { DECLINE_CATEGORY_LABEL } from "./labels";
import type { AdvisorResponse, FunnelCounts, FunnelDetail, PathFunnel, RuleFunnel } from "./types";

function percent(part: number, whole: number): string {
  if (whole <= 0) return "–";
  return `${Math.round((100 * part) / whole)}%`;
}

function advisorUrl(siteId: string, mode: "funnel" | "ai" | "refresh"): string {
  const params = new URLSearchParams({ siteId });
  if (mode === "ai") params.set("ai", "1");
  if (mode === "refresh") params.set("refresh", "1");
  return `/api/publisher/advisor?${params}`;
}

// --- Funnel ---------------------------------------------------------------------------------------

function Kpi({
  label,
  value,
  hint,
  progress,
}: {
  label: string;
  value: string;
  hint?: string;
  /** 0 to 1: a small bar under the value (the hint says the same in words). */
  progress?: number;
}) {
  return (
    <div className="min-w-0 space-y-0.5 rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {progress !== undefined && (
        <div
          className="my-1 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
          aria-hidden
        >
          <div
            className="h-full rounded-full bg-success"
            style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
          />
        </div>
      )}
      {hint && <div className="line-clamp-2 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Offers → paid → cited as nested bars, so a page that sells but is never used stands out. */
function FunnelBar({ counts }: { counts: FunnelCounts }) {
  const top = Math.max(counts.offers, counts.paid + counts.declined, 1);
  const width = (n: number) => `${Math.min(100, (100 * n) / top)}%`;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className="absolute inset-y-0 left-0 bg-primary/25"
        style={{ width: width(counts.offers) }}
      />
      <div
        className="absolute inset-y-0 left-0 bg-primary/60"
        style={{ width: width(counts.paid) }}
      />
      <div
        className="absolute inset-y-0 left-0 bg-emerald-500"
        style={{ width: width(counts.cited) }}
      />
    </div>
  );
}

function Reasons({ detail }: { detail: FunnelDetail }) {
  const categories = Object.entries(detail.declinedByCategory).filter(([, n]) => (n ?? 0) > 0);
  if (detail.declined === 0) {
    return <p className="text-xs text-muted-foreground">No decline notes for this page yet.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {categories.map(([category, n]) => (
          <Badge key={category} variant="outline" className="font-normal">
            {DECLINE_CATEGORY_LABEL[category as DeclineCategory]}
            <span className="tabular-nums text-muted-foreground">{n}</span>
          </Badge>
        ))}
      </div>
      <ReasonBars reasons={detail.topReasons} />
    </div>
  );
}

const NUMBER_COLUMNS: { key: keyof FunnelCounts; label: string }[] = [
  { key: "offers", label: "Offers" },
  { key: "paid", label: "Paid" },
  { key: "declined", label: "Declined" },
  { key: "cited", label: "Cited" },
  { key: "disputed", label: "Disputed" },
];

/** Columns hidden on phones (with Bought), so the rule, offers, paid and cited fit at 375px. */
const WIDE_ONLY: Partial<Record<keyof FunnelCounts, string>> = {
  declined: "hidden sm:table-cell",
  disputed: "hidden sm:table-cell",
};

function PathRows({ paths }: { paths: PathFunnel[] }) {
  if (paths.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No page under this rule has signals yet.</p>
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {paths.map((path) => (
        <li key={path.path} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2.5 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={path.path}>
            {path.path}
          </code>
          <span className="text-xs text-muted-foreground tabular-nums">
            {path.offers} offers · {path.paid} paid · {path.declined} declined ·{" "}
            <span className="text-foreground">{path.cited} cited</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** After a price change: the counts are for the new price only, and say so. */
function EarlierPrices({ rule }: { rule: RuleFunnel }) {
  const earlier = rule.earlier;
  if (!earlier) return null;
  const prices = earlier.priceCents.map(formatPrice).join(", ");
  return (
    <span className="block text-xs text-muted-foreground">
      {rule.awaitingSignals
        ? `Price changed from ${prices}. Waiting for agents to see ${formatPrice(rule.priceCents)}.`
        : `Counts at ${formatPrice(rule.priceCents)} only; ${formatCount(earlier.offers)} offers and ${formatCount(earlier.paid)} purchases at ${prices} not shown.`}
    </span>
  );
}

function RuleRow({ rule }: { rule: RuleFunnel }) {
  const [open, setOpen] = useState(false);
  const id = `advisor-rule-${rule.method}-${rule.pattern}`.replace(/[^a-zA-Z0-9-]/g, "_");
  return (
    <Fragment>
      <tr className="border-b align-top last:border-b-0">
        <td className="py-2.5 pr-3">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={id}
            className="group flex w-full min-w-36 items-start gap-1.5 text-left sm:min-w-44"
          >
            <ChevronRight
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="flex items-center gap-1.5">
                <code className="truncate font-mono text-xs group-hover:underline">
                  {rule.method !== "GET" && `${rule.method} `}
                  {rule.pattern}
                </code>
                <Badge variant="secondary" className="font-normal tabular-nums">
                  {formatPrice(rule.priceCents)}
                </Badge>
              </span>
              <FunnelBar counts={rule} />
              {rule.earlier && <EarlierPrices rule={rule} />}
            </span>
          </button>
        </td>
        {NUMBER_COLUMNS.map((column) => (
          <td
            key={column.key}
            className={cn(
              "px-2 py-2.5 text-right text-sm tabular-nums",
              WIDE_ONLY[column.key],
              column.key === "cited" && "font-medium",
              rule[column.key] === 0 && "text-muted-foreground",
            )}
          >
            {formatCount(rule[column.key])}
          </td>
        ))}
        <td className="hidden py-2.5 pl-2 text-right text-sm text-muted-foreground tabular-nums sm:table-cell">
          {percent(rule.paid, Math.max(rule.offers, rule.paid + rule.declined))}
        </td>
      </tr>
      {open && (
        <tr id={id} className="border-b bg-muted/30 last:border-b-0">
          <td colSpan={NUMBER_COLUMNS.length + 2} className="px-3 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium">Pages</div>
                <PathRows paths={rule.paths} />
              </div>
              <div className="space-y-2">
                <div className="text-xs font-medium">Why agents didn&apos;t buy</div>
                <Reasons detail={rule} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function FunnelTable({ rules }: { rules: RuleFunnel[] }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-0 text-left sm:min-w-[640px]">
        <caption className="sr-only">
          Offers, purchases, declines, citations and disputes per pricing rule
        </caption>
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Pricing rule</th>
            {NUMBER_COLUMNS.map((column) => (
              <th
                key={column.key}
                className={cn("px-2 py-2 text-right font-medium", WIDE_ONLY[column.key])}
              >
                {column.label}
              </th>
            ))}
            <th className="hidden py-2 pl-2 text-right font-medium sm:table-cell">Bought</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <RuleRow key={`${rule.method} ${rule.pattern}`} rule={rule} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Recommendations ------------------------------------------------------------------------------

function RecommendationsSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-busy="true" aria-label="Asking the AI">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2 rounded-lg border p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
    </div>
  );
}

function Recommendations({
  data,
  loadingAi,
  onApplied,
  onRetry,
}: {
  data: AdvisorResponse;
  loadingAi: boolean;
  onApplied: (site: SiteView) => void;
  onRetry: () => void;
}) {
  if (data.aiStatus === "unavailable") {
    return (
      <Alert>
        <KeyRound />
        <AlertTitle>AI recommendations need an AI provider key</AlertTitle>
        <AlertDescription>
          {data.aiMessage ?? "Set an AI provider key on the server."} The funnel below works without
          it.
        </AlertDescription>
      </Alert>
    );
  }
  if (loadingAi || data.aiStatus === "pending") return <RecommendationsSkeleton />;
  if (data.aiStatus === "insufficient_data") {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        {data.aiMessage}
      </p>
    );
  }
  // Suggestions were made but none matched the numbers: offer a retry, never "nothing to change".
  const discarded = data.recommendations.length === 0 && data.dropped > 0;
  if (data.aiStatus === "error" || discarded) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>No recommendations right now</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {data.aiMessage ??
            "The AI's suggestions did not match your numbers, so BotFare discarded them."}
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (data.recommendations.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        The AI found nothing worth changing yet. Your prices match what agents do.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {data.recommendations.map((rec) => (
        <RecommendationItem key={rec.id} siteId={data.siteId} rec={rec} onApplied={onApplied} />
      ))}
    </ul>
  );
}

// --- Card -----------------------------------------------------------------------------------------

/**
 * "Fare Advisor" on /publisher: per pricing rule, offers → paid → cited, declines and disputes,
 * why agents did not buy, and the AI's checked recommendations with one-click Apply.
 */
export function FareAdvisorCard({
  sites,
  onApplied,
}: {
  sites: SiteView[];
  onApplied: (site: SiteView) => void;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const site = sites.find((candidate) => candidate.id === siteId) ?? sites[0];
  const [data, setData] = useState<AdvisorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingAi, setLoadingAi] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (id: string, mode: "funnel" | "refresh") => {
    const ticket = ++request.current;
    setLoading(true);
    // A refresh asks the model straight away: show the recommendations as loading.
    setLoadingAi(mode === "refresh");
    setError(null);
    try {
      let next = await api<AdvisorResponse>(
        "GET",
        advisorUrl(id, mode === "refresh" ? "refresh" : "funnel"),
      );
      if (ticket !== request.current) return;
      setData(next);
      setLoading(false);
      if (next.aiStatus === "pending") {
        setLoadingAi(true);
        next = await api<AdvisorResponse>("GET", advisorUrl(id, "ai"));
        if (ticket !== request.current) return;
        setData(next);
      }
    } catch (err) {
      if (ticket === request.current) setError(errorText(err));
    } finally {
      if (ticket === request.current) {
        setLoading(false);
        setLoadingAi(false);
      }
    }
  }, []);

  // Reload when the site or its prices change (a saved price changes the config version).
  const version = site?.version;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is a deliberate reload trigger
  useEffect(() => {
    if (site?.id) void load(site.id, "funnel");
  }, [site?.id, version, load]);

  if (!site) return null;
  const summary = data?.siteId === site.id ? data.inputsSummary : null;
  const totals = summary?.totals;
  const busy = loading || loadingAi;

  return (
    <Card>
      <CardHeader>
        {/* A flex row rather than CardAction, so phones stack the controls under the text. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              Fare Advisor
            </CardTitle>
            <CardDescription>
              Why agents buy, skip and cite your pages
              {summary ? `, over the last ${summary.days} days` : ""}. Nothing changes until you
              click Apply.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {sites.length > 1 && (
              <Select
                value={site.id}
                items={sites.map((s) => ({ value: s.id, label: s.name }))}
                onValueChange={(value) => setSiteId(String(value))}
              >
                <SelectTrigger size="sm" className="w-40 sm:w-48" aria-label="Site">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => load(site.id, data?.aiAvailable ? "refresh" : "funnel")}
              disabled={busy}
              aria-label="Refresh Fare Advisor"
              title="Refresh"
            >
              <RefreshCw className={cn(busy && "animate-spin")} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && !summary ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Fare Advisor could not load</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error}
              <Button size="xs" variant="outline" onClick={() => load(site.id, "funnel")}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : !summary || !totals ? (
          <div
            className="space-y-3"
            role="status"
            aria-busy="true"
            aria-label="Loading Fare Advisor"
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Kpi label="Offers shown" value={formatCount(totals.offers)} />
              <Kpi
                label="Paid"
                value={formatCount(totals.paid)}
                progress={totals.paid / Math.max(totals.offers, totals.paid + totals.declined, 1)}
                hint={`${percent(totals.paid, Math.max(totals.offers, totals.paid + totals.declined))} of offers`}
              />
              <Kpi label="Declined" value={formatCount(totals.declined)} hint="with a reason" />
              <Kpi
                label="Cited in answers"
                value={formatCount(totals.cited)}
                hint="Citations are the new clicks"
              />
              <Kpi
                label="Disputed"
                value={formatCount(totals.disputed)}
                hint={
                  totals.disputeRefundedCents > 0
                    ? `${formatPrice(totals.disputeRefundedCents)} refunded`
                    : undefined
                }
              />
            </div>

            <section className="space-y-3" aria-labelledby="advisor-recs">
              <div className="flex items-center justify-between gap-2">
                <h3 id="advisor-recs" className="text-sm font-medium">
                  Recommendations
                </h3>
                {data?.aiAvailable && data.generatedAt && !loadingAi && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {loading && <Loader2 className="size-3 animate-spin" />}
                    {data.aiLabel ?? "AI"} · checked by BotFare
                  </span>
                )}
              </div>
              {data && (
                <Recommendations
                  data={data}
                  loadingAi={loadingAi}
                  onApplied={onApplied}
                  onRetry={() => load(site.id, "refresh")}
                />
              )}
            </section>

            <section className="space-y-3" aria-labelledby="advisor-funnel">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h3 id="advisor-funnel" className="text-sm font-medium">
                  Funnel per pricing rule
                </h3>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <Legend className="bg-primary/25" label="Offers" />
                  <Legend className="bg-primary/60" label="Paid" />
                  <Legend className="bg-emerald-500" label="Cited" />
                </div>
              </div>
              {summary.rules.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  Add a pricing rule to see how agents respond to it.
                </p>
              ) : (
                <FunnelTable rules={summary.rules} />
              )}
              {summary.unpriced.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {summary.unpriced.length}{" "}
                  {summary.unpriced.length === 1 ? "page has" : "pages have"} signals but no current
                  rule (e.g. <code className="font-mono">{summary.unpriced[0]?.path}</code>).
                </p>
              )}
            </section>

            <section className="space-y-3" aria-labelledby="advisor-reasons">
              <h3 id="advisor-reasons" className="flex items-center gap-1.5 text-sm font-medium">
                <MessageSquareQuote className="size-4 text-muted-foreground" />
                Why agents didn&apos;t buy
              </h3>
              {totals.declined === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No decline notes yet. Agents that skip an offer can say why; their notes show up
                  here, without any personal data.
                </p>
              ) : (
                <Reasons
                  detail={{
                    ...totals,
                    declinedByCategory: summary.declinedByCategory,
                    topReasons: summary.topReasons,
                  }}
                />
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("size-2 rounded-full", className)} />
      {label}
    </span>
  );
}
