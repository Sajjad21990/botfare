"use client";

import { RECEIPT_KEYS_PATH } from "@botfare/contracts/receipts";
import { cn } from "cn";
import { Check, Minus, ShieldAlert, ShieldCheck, ShieldX, Undo2, X } from "lucide-react";
import landing from "@/components/landing/landing.module.css";
import { NewTabLink } from "@/components/landing/new-tab-link";
import type { CheckItem, CheckState, ReceiptSummary, TimelineItem } from "./receipt-summary";
import { verdictText } from "./receipt-summary";
import { formatFareMicros, formatInstant } from "./statement-copy";

const inlineLink = `${landing.focusRing} rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`;

/**
 * One line under the ticket: do the signatures hold, and who checked them. A failure lists each
 * statement that did not verify, in red, with the reason.
 */
export function VerdictLine({ summary, keyCount }: { summary: ReceiptSummary; keyCount: number }) {
  const { trusted, total } = summary;
  const Icon = total === 0 ? ShieldAlert : trusted ? ShieldCheck : ShieldX;
  const keys = keyCount === 1 ? "public key" : "public keys";
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2.5 text-sm leading-relaxed">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-5 shrink-0",
            total === 0 ? "text-muted-foreground" : trusted ? "text-success" : "text-stamp",
          )}
        />
        <span>
          <strong className={cn("font-semibold", !trusted && total > 0 && "text-stamp")}>
            {verdictText(summary)}
          </strong>{" "}
          Your browser checked {total === 1 ? "it" : "them"} with BotFare&apos;s{" "}
          <NewTabLink
            href={RECEIPT_KEYS_PATH}
            title={RECEIPT_KEYS_PATH}
            icon={false}
            className={inlineLink}
          >
            {keys}
          </NewTabLink>
          .
        </span>
      </p>
      {summary.failures.length > 0 ? (
        <ul className="ml-[1.875rem] flex flex-col gap-1.5 text-sm">
          {summary.failures.map((failure) => (
            <li key={failure.token} className="text-stamp">
              <span className="font-semibold">{failure.title}.</span> {failure.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const SPOKEN: Record<CheckState, string> = {
  pass: "Yes",
  fail: "Failed",
  none: "No",
  refunded: "Yes",
};

function CheckMark({ state, trusted }: { state: CheckState; trusted: boolean }) {
  const base = "flex size-7 shrink-0 items-center justify-center rounded-full";
  if (state === "pass") {
    return (
      <span
        aria-hidden
        className={cn(base, trusted ? "bg-success text-white" : "bg-foreground text-background")}
      >
        <Check className="size-4" strokeWidth={3} />
      </span>
    );
  }
  if (state === "fail") {
    return (
      <span aria-hidden className={cn(base, "bg-stamp text-white")}>
        <X className="size-4" strokeWidth={3} />
      </span>
    );
  }
  if (state === "refunded") {
    return (
      <span aria-hidden className={cn(base, "border-2 border-stamp text-stamp")}>
        <Undo2 className="size-3.5" strokeWidth={2.75} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(base, "border-2 border-dashed border-foreground/30 text-muted-foreground")}
    >
      <Minus className="size-3.5" strokeWidth={2.75} />
    </span>
  );
}

/** Four plain checks, each derived from the statements alone. */
export function ReceiptChecks({ checks, trusted }: { checks: CheckItem[]; trusted: boolean }) {
  return (
    <section aria-labelledby="checks-title" className="flex flex-col gap-3">
      <h2 id="checks-title" className="text-lg font-bold">
        What we checked
      </h2>
      <ul className="flex flex-col gap-2">
        {checks.map((check) => (
          <li
            key={check.id}
            className={cn(
              "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5",
              check.state === "fail" ? "border-stamp/50" : "border-foreground/15",
            )}
          >
            <CheckMark state={check.state} trusted={trusted} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {check.label}
                <span className="sr-only">: {SPOKEN[check.state]}.</span>
              </p>
              <p
                className={cn(
                  "truncate text-sm",
                  check.state === "fail" ? "text-stamp" : "text-muted-foreground",
                )}
                title={check.detail}
              >
                {check.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TimelineDot({ item }: { item: TimelineItem }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-0.5 left-0 z-10 size-5 rounded-full border-2",
        item.upcoming
          ? "border-dashed border-foreground/45 bg-card"
          : item.id === "refunded"
            ? "border-stamp bg-stamp"
            : item.id === "window"
              ? "border-foreground/45 bg-muted"
              : "border-foreground bg-brand",
      )}
    />
  );
}

/**
 * What happened to the fare, in order, from the statements' own timestamps: a row of stops on a
 * wide screen, a vertical line on a phone.
 */
export function ReceiptTimeline({ items }: { items: TimelineItem[] }) {
  return (
    <section
      aria-labelledby="timeline-title"
      className="flex flex-col gap-4 rounded-xl border border-foreground/15 bg-card p-4 sm:p-5"
    >
      <h2 id="timeline-title" className="text-lg font-bold">
        What happened
      </h2>
      <ol
        className="flex flex-col md:grid md:gap-6"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item, index) => (
          <li key={item.id} className="group relative pb-5 pl-8 last:pb-0 md:pb-0 md:pl-0 md:pt-8">
            <TimelineDot item={item} />
            <span
              aria-hidden
              className="absolute top-6 bottom-0.5 left-[9px] w-0.5 bg-foreground/20 group-last:hidden md:hidden"
            />
            <span
              aria-hidden
              className={cn(
                "absolute top-[11px] right-[-1.5rem] left-5 hidden h-0.5 group-last:hidden md:block",
                items[index + 1]?.upcoming
                  ? "border-t-2 border-dashed border-foreground/30"
                  : "bg-foreground/25",
              )}
            />
            <p className="text-sm font-semibold">{item.title}</p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={item.at}>{formatInstant(item.at)}</time>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The fare split between the site and BotFare, from the payment statement's own figures. */
export function MoneySplitBar({ summary }: { summary: ReceiptSummary }) {
  const { split, refund, payment } = summary;
  if (!split || !payment) return null;
  const full = refund && refund.refund.refundedMicros === payment.payment.amountMicros;
  return (
    <section aria-labelledby="split-title" className="flex flex-col gap-3">
      <h2 id="split-title" className="text-lg font-bold">
        Where the {split.amount} went
      </h2>
      <div className="flex flex-col gap-3 rounded-xl border border-foreground/15 bg-card p-4">
        <div
          aria-hidden
          className="flex h-6 overflow-hidden rounded-md border-[1.5px] border-foreground"
        >
          <div className="bg-brand" style={{ width: `${split.publisherShare}%` }} />
          <div className="min-w-[3px] flex-1 border-l-[1.5px] border-foreground bg-foreground" />
        </div>
        <ul className="flex flex-wrap justify-between gap-x-6 gap-y-1.5 text-sm">
          <li className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-[3px] border border-foreground bg-brand" />
            The site
            <span className={cn(landing.tabular, "font-semibold")}>{split.publisher}</span>
            <span className="text-muted-foreground">({split.publisherPercent}%)</span>
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-[3px] bg-foreground" />
            BotFare fee
            <span className={cn(landing.tabular, "font-semibold")}>{split.fee}</span>
            <span className="text-muted-foreground">({split.feePercent}%)</span>
          </li>
        </ul>
        {refund ? (
          <p className="flex items-start gap-2 border-t border-dashed border-foreground/25 pt-3 text-sm">
            <Undo2 aria-hidden className="mt-0.5 size-4 shrink-0 text-stamp" />
            <span>
              {full
                ? `The full ${split.amount} was refunded`
                : `${formatFareMicros(refund.refund.refundedMicros)} of the ${split.amount} was refunded`}{" "}
              {refund.refund.via === "dispute" ? "through Fare Court" : "by the publisher"}.
            </span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
