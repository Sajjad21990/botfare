"use client";

import {
  AlertTriangle,
  BookOpen,
  Brain,
  CircleSlash,
  Loader2,
  ReceiptText,
  Scale,
  ShieldAlert,
  ShoppingCart,
  Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatFare, shortPath } from "./format";
import { isInspectable, type RunView, type TimelineEntry } from "./run-state";

const REFUSED_BY: Record<string, string> = {
  "spend-limit": "SDK spend limit",
  budget: "Run budget",
  publisher: "Facilitator",
};

/** Dispute reasons in the timeline's words. */
const DISPUTE_REASON: Record<string, string> = {
  stub_or_paywall: "subscription stub",
  error_page: "error page",
  truncated: "cut short",
  unrelated: "unrelated content",
  not_as_described: "not as described",
  other: "content mismatch",
};

/** Dispute statuses as a badge. */
const DISPUTE_STATUS: Record<
  string,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  refunded: { label: "Refunded", variant: "secondary" },
  denied: { label: "Denied", variant: "outline" },
  pending_publisher: { label: "Publisher review", variant: "outline" },
  rejected_by_publisher: { label: "Publisher declined", variant: "outline" },
  invalid: { label: "Not accepted", variant: "destructive" },
  failed: { label: "Not filed", variant: "destructive" },
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

interface TimelineProps {
  view: RunView;
  selected: string | null;
  onSelect: (toolCallId: string) => void;
}

/** What the agent did, in order: notes, catalogs, offers, decisions, refusals and payments. */
export function Timeline({ view, selected, onSelect }: TimelineProps) {
  const busy = view.status === "running" || view.status === "starting";
  const shown = view.entries.filter((e) => !(e.kind === "note" && e.source === "thinking"));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>
          What the agent did, step by step. Click a payment to see the messages behind it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          busy ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Starting the agent… A run takes 1 to 2 minutes.
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <ReceiptText className="size-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">Nothing yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Ask a question to start. The agent&apos;s offers, decisions and payments show up
                  here as they happen.
                </p>
              </div>
            </div>
          )
        ) : (
          <ol className="flex flex-col">
            {shown.map((entry, index) => (
              <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
                {index < shown.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute top-8 bottom-0 left-[15px] w-px bg-border"
                  />
                ) : null}
                <EntryRow
                  entry={entry}
                  view={view}
                  selected={isInspectable(entry) && entry.toolCallId === selected}
                  onSelect={onSelect}
                />
              </li>
            ))}
            {busy ? (
              <li className="flex items-center gap-3 pl-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Working… A run takes 1 to 2 minutes. Payments appear here as they happen.
              </li>
            ) : null}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function Icon({ children, tone = "muted" }: { children: ReactNode; tone?: string }) {
  return (
    <span
      className={cn(
        "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background [&_svg]:size-4",
        tone === "paid" && "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
        tone === "refused" && "border-destructive/40 text-destructive",
        tone === "skip" && "border-amber-500/40 text-amber-600 dark:text-amber-400",
        tone === "dispute" && "border-sky-500/40 text-sky-600 dark:text-sky-400",
        tone === "muted" && "text-muted-foreground",
        tone === "primary" && "text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Selectable({
  toolCallId,
  selected,
  onSelect,
  children,
}: {
  toolCallId: string;
  selected: boolean;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(toolCallId)}
      aria-pressed={selected}
      className={cn(
        "-mx-2 -my-1 flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/60",
        selected && "bg-muted ring-1 ring-foreground/10",
      )}
    >
      {children}
    </button>
  );
}

function Title({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium">{children}</span>
      {aside}
    </div>
  );
}

function Url({ url }: { url: string }) {
  return (
    <span className="block truncate font-mono text-xs text-muted-foreground">{shortPath(url)}</span>
  );
}

function EntryRow({
  entry,
  view,
  selected,
  onSelect,
}: {
  entry: TimelineEntry;
  view: RunView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  switch (entry.kind) {
    case "note":
      return (
        <>
          <Icon>
            <Brain />
          </Icon>
          <p className="min-w-0 flex-1 pt-1.5 text-sm whitespace-pre-wrap text-muted-foreground italic">
            {entry.text.trim()}
          </p>
        </>
      );
    case "sources": {
      const available = entry.sources.filter((source) => source.available);
      return (
        <>
          <Icon>
            <BookOpen />
          </Icon>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <Title>
              Read {available.length} free {available.length === 1 ? "catalog" : "catalogs"}
            </Title>
            <ul className="text-sm text-muted-foreground">
              {entry.sources.map((source) => (
                <li key={source.siteId} className="truncate">
                  {source.siteName}:{" "}
                  {source.available
                    ? `${source.articleCount} ${source.articleCount === 1 ? "page" : "pages"}`
                    : (source.error ?? "unavailable")}
                </li>
              ))}
            </ul>
          </div>
        </>
      );
    }
    case "offer":
      return (
        <>
          <Icon>
            <Tag />
          </Icon>
          <Selectable toolCallId={entry.toolCallId} selected={selected} onSelect={onSelect}>
            <Title
              aside={
                <Badge variant="outline">
                  {entry.free ? "Free" : `${formatFare(entry.priceCents)} offer`}
                </Badge>
              }
            >
              {entry.title ?? "Untitled page"}
            </Title>
            {entry.excerpt ? (
              <p className="line-clamp-2 text-sm text-muted-foreground">{entry.excerpt}</p>
            ) : null}
            <Url url={entry.url} />
          </Selectable>
        </>
      );
    case "decision":
      return entry.action === "buy" ? (
        <>
          <Icon tone="primary">
            <ShoppingCart />
          </Icon>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <Title
              aside={
                entry.priceCents !== null ? (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatFare(entry.priceCents)}
                  </span>
                ) : null
              }
            >
              Decided to buy {entry.title ? `“${entry.title}”` : shortPath(entry.url)}
            </Title>
            <p className="text-sm text-muted-foreground">{entry.reason}</p>
          </div>
        </>
      ) : (
        <>
          <Icon tone="skip">
            <CircleSlash />
          </Icon>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <Title aside={<Badge variant="secondary">Judgement</Badge>}>
              Skipped {entry.title ? `“${entry.title}”` : shortPath(entry.url)}
              {entry.priceCents !== null ? ` (${formatFare(entry.priceCents)})` : ""}
            </Title>
            <p className="text-sm text-muted-foreground">{entry.reason}</p>
          </div>
        </>
      );
    case "refusal":
      return (
        <>
          <Icon tone="refused">
            <ShieldAlert />
          </Icon>
          <Selectable toolCallId={entry.toolCallId} selected={selected} onSelect={onSelect}>
            <Title aside={<Badge variant="destructive">{REFUSED_BY[entry.by] ?? entry.by}</Badge>}>
              {entry.by === "spend-limit" && entry.priceCents !== null
                ? `Refused: ${formatFare(entry.priceCents)} is over the ${formatFare(view.maxPerRequestCents)} cap`
                : "Purchase refused"}
            </Title>
            <p className="text-sm text-muted-foreground">
              {entry.by === "spend-limit"
                ? "The SDK's spend controls stopped it before anything was signed. No money moved."
                : entry.message}
            </p>
            <Url url={entry.url} />
          </Selectable>
        </>
      );
    case "payment":
      return (
        <>
          <Icon tone="paid">
            <ReceiptText />
          </Icon>
          <Selectable toolCallId={entry.toolCallId} selected={selected} onSelect={onSelect}>
            <Title
              aside={
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatFare(entry.remainingCents)} left
                </span>
              }
            >
              Paid {formatFare(entry.amountCents)} to {entry.siteName}
            </Title>
            <span className="truncate text-sm text-muted-foreground">
              {entry.title ?? shortPath(entry.url)}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{entry.receiptId}</span>
          </Selectable>
        </>
      );
    case "dispute": {
      const { outcome } = entry;
      const status = outcome ? DISPUTE_STATUS[outcome.status] : undefined;
      const reason = DISPUTE_REASON[entry.reason] ?? entry.reason;
      let result: string;
      if (!outcome) result = "The judge is comparing the offer with what arrived…";
      else if (outcome.status === "refunded")
        result = `→ refunded ${formatFare(outcome.refundedCents)} in ${seconds(outcome.elapsedMs)}`;
      else if (outcome.status === "denied") result = "→ denied: the content matched the offer";
      else if (outcome.status === "pending_publisher")
        result = "→ sent to the publisher for review";
      else result = `→ ${outcome.message}`;
      return (
        <>
          <Icon tone={outcome?.status === "refunded" ? "paid" : "dispute"}>
            {outcome ? <Scale /> : <Loader2 className="animate-spin" />}
          </Icon>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <Title
              aside={
                status ? (
                  <Badge variant={status.variant}>{status.label}</Badge>
                ) : (
                  <Badge variant="outline">Fare Court</Badge>
                )
              }
            >
              Disputed {formatFare(entry.amountCents)}: {reason}
            </Title>
            <p className="text-sm text-foreground">{result}</p>
            {entry.note ? <p className="text-sm text-muted-foreground">“{entry.note}”</p> : null}
            {outcome?.verdict ? (
              <p className="text-sm text-muted-foreground">
                Judge ({Math.round(outcome.verdict.confidence * 100)}% sure):{" "}
                {outcome.verdict.rationale}
              </p>
            ) : null}
            <span className="truncate text-sm text-muted-foreground">
              {entry.title ?? shortPath(entry.url)}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{entry.receiptId}</span>
          </div>
        </>
      );
    }
    case "tool-error":
      return (
        <>
          <Icon>
            <AlertTriangle />
          </Icon>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
            <Title>{entry.name} failed</Title>
            <p className="text-sm break-words text-muted-foreground">{entry.message}</p>
          </div>
        </>
      );
  }
}
