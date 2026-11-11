"use client";

import { cn } from "cn";
import { ArrowUpRightIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import landing from "@/components/landing/landing.module.css";
import { NewTabLink } from "@/components/landing/new-tab-link";
import { NotchedTicket } from "@/components/landing/notched-ticket";
import { CopyButton } from "@/components/publisher/copy-button";
import type { ReceiptSummary } from "./receipt-summary";
import { formatFareMicros, formatWhen, hostOf, pageLabel } from "./statement-copy";
import styles from "./verify.module.css";

interface Stamp {
  word: string;
  /** Read after the word by screen readers. */
  meaning: string;
  tone: "green" | "red";
  tilt: string;
  delay: string;
}

function stampsFor(summary: ReceiptSummary): Stamp[] {
  if (!summary.trusted) {
    return [
      {
        word: "Not valid",
        meaning: "a signature did not verify",
        tone: "red",
        tilt: "-7deg",
        delay: "120ms",
      },
    ];
  }
  const stamps: Stamp[] = [];
  if (summary.payment) {
    stamps.push({
      word: "Paid",
      meaning: "payment signature valid",
      tone: "green",
      tilt: "-8deg",
      delay: "120ms",
    });
  }
  if (summary.delivery) {
    stamps.push({
      word: "Delivered",
      meaning: "delivery signature valid",
      tone: "green",
      tilt: "-3deg",
      delay: "320ms",
    });
  }
  if (summary.refund) {
    stamps.push({
      word: "Refunded",
      meaning: "refund signature valid",
      tone: "red",
      tilt: "-11deg",
      delay: "520ms",
    });
  }
  return stamps;
}

/** An http(s) URL, or null: only these become links. */
function webUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The receipt at a glance, printed like the landing's hero ticket: who was paid, for which page,
 * when, the fare, and a stamp for each signed statement that verified. A receipt whose signatures
 * do not all verify is printed on plain stock with one red stamp and no green.
 */
export function ReceiptTicket({
  summary,
  sample,
  siteName,
}: {
  summary: ReceiptSummary;
  /** The page's sample receipt rather than one the viewer asked for. */
  sample: boolean;
  /** The site's name when the page knows it (the sample is always the demo site). */
  siteName: string | null;
}) {
  const payment = summary.paymentAsWritten;
  const p = payment?.payment ?? null;
  const host = p ? (hostOf(p.siteOrigin) ?? p.payTo) : null;
  // Only a page a verified statement names becomes a link.
  const pageUrl = summary.payment ? webUrl(summary.payment.payment.resource) : null;
  const stamps = stampsFor(summary);
  const receiptId = summary.receiptId ?? payment?.sub ?? null;

  return (
    <div className={cn(!summary.trusted && styles.void)}>
      <NotchedTicket>
        <div className="space-y-4 px-5 pt-5 pb-5 sm:px-6">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 font-heading font-extrabold">
              <BotFareMark className="size-6" />
              BotFare
            </span>
            {sample ? (
              <span className="rounded-sm border-[1.5px] border-current px-1.5 py-px font-mono text-[0.7rem] font-semibold tracking-wider uppercase">
                Sample receipt
              </span>
            ) : (
              <span className="font-medium tracking-wide text-muted-foreground uppercase">
                Receipt
              </span>
            )}
          </div>

          {p ? (
            <dl className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5">
              <dt className="text-sm text-muted-foreground">Paid to</dt>
              <dd className="min-w-0">
                <span className="block truncate text-lg leading-snug font-semibold">
                  {siteName ?? host}
                </span>
                {siteName && host ? (
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {host}
                  </span>
                ) : null}
              </dd>
              {p.resource ? (
                <>
                  <dt className="text-sm text-muted-foreground">Page</dt>
                  <dd className="min-w-0">
                    {pageUrl ? (
                      <NewTabLink
                        href={pageUrl}
                        title={pageUrl}
                        icon={<ArrowUpRightIcon aria-hidden className="ml-0.5 size-3.5 shrink-0" />}
                        className={`${landing.focusRing} inline-flex max-w-full items-center rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`}
                      >
                        <span className="truncate">{pageLabel(pageUrl)}</span>
                      </NewTabLink>
                    ) : (
                      <span title={p.resource} className="block truncate font-medium">
                        {pageLabel(p.resource)}
                      </span>
                    )}
                  </dd>
                </>
              ) : null}
              <dt className="text-sm text-muted-foreground">Paid by</dt>
              <dd className="min-w-0 truncate text-sm">
                Agent key <span className="font-mono text-[0.8rem]">{p.payer}</span>
              </dd>
              <dt className="text-sm text-muted-foreground">When</dt>
              <dd className="text-sm">
                <time dateTime={p.settledAt}>{formatWhen(p.settledAt)}</time>
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              There is no payment statement, so the ticket cannot say who was paid.
            </p>
          )}
        </div>

        <div
          aria-hidden
          data-perforation
          className="mx-5 border-t-2 border-dashed border-foreground/35 sm:mx-6"
        />

        <div className="flex items-end justify-between gap-3 px-5 pt-5 pb-5 sm:px-6">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Fare</p>
            {p ? (
              <p
                className={cn(
                  landing.tabular,
                  "font-heading text-6xl leading-none font-extrabold tracking-tight",
                  !summary.trusted && "text-foreground/60",
                )}
              >
                {formatFareMicros(p.amountMicros)}
              </p>
            ) : (
              <p className="font-heading text-2xl font-bold">Not signed</p>
            )}
          </div>
          {stamps.length > 0 ? (
            <ul aria-label="Stamps" className="flex shrink-0 flex-col items-end gap-2 pb-1">
              {stamps.map((stamp) => (
                <li key={stamp.word}>
                  <span
                    style={
                      { "--stamp-tilt": stamp.tilt, "--stamp-delay": stamp.delay } as CSSProperties
                    }
                    className={cn(
                      styles.stamp,
                      stamp.tone === "green" ? styles.stampGreen : styles.stampRed,
                      "inline-block rounded-md border-[3px] px-2.5 py-0.5 font-heading text-xl leading-tight font-extrabold tracking-wider whitespace-nowrap uppercase",
                    )}
                  >
                    {stamp.word}
                    <span className="sr-only">, {stamp.meaning}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {summary.trusted && summary.refund ? (
          <p className="px-5 pb-5 text-sm font-medium text-pretty sm:px-6">
            Refunded {formatFareMicros(summary.refund.refund.refundedMicros)}{" "}
            {summary.refund.refund.via === "dispute" ? "through Fare Court" : "by the publisher"}
            {", "}
            <time dateTime={summary.refund.refund.refundedAt}>
              {formatWhen(summary.refund.refund.refundedAt)}
            </time>
            .
          </p>
        ) : null}
        {!summary.trusted && p ? (
          <p className="px-5 pb-5 text-sm font-medium text-pretty sm:px-6">
            Shown as written. The signatures do not prove it.
          </p>
        ) : null}

        {receiptId ? (
          <div className="flex items-center justify-between gap-2 border-t-[1.5px] border-dashed border-foreground/35 py-1.5 pr-3 pl-5 sm:pl-6">
            <p className="min-w-0 truncate font-mono text-xs" title={receiptId}>
              <span className="text-muted-foreground">No. </span>
              {receiptId}
            </p>
            <CopyButton
              value={receiptId}
              label="Copy receipt ID"
              className="size-7 shrink-0 hover:bg-foreground/10"
            />
          </div>
        ) : null}
      </NotchedTicket>
    </div>
  );
}

/** The ticket's shape while the statements are fetched and checked. */
export function TicketSkeleton() {
  return (
    <NotchedTicket>
      <div className="space-y-5 px-5 pt-5 pb-5 sm:px-6">
        <div className="flex items-center justify-between text-sm">
          <span className="inline-flex items-center gap-1.5 font-heading font-extrabold">
            <BotFareMark className="size-6" />
            BotFare
          </span>
          <span className="font-medium tracking-wide text-muted-foreground uppercase">Receipt</span>
        </div>
        <div className="space-y-3">
          <div className={cn(styles.pulse, "h-5 w-3/5 rounded-md")} />
          <div className={cn(styles.pulse, "h-4 w-2/5 rounded-md")} />
          <div className={cn(styles.pulse, "h-4 w-1/2 rounded-md")} />
          <div className={cn(styles.pulse, "h-4 w-3/5 rounded-md")} />
        </div>
      </div>
      <div
        aria-hidden
        data-perforation
        className="mx-5 border-t-2 border-dashed border-foreground/35 sm:mx-6"
      />
      <div className="flex items-end justify-between gap-3 px-5 pt-5 pb-6 sm:px-6">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Fare</p>
          <div className={cn(styles.pulse, "h-14 w-24 rounded-md")} />
        </div>
        <div className={cn(styles.pulse, "h-8 w-24 -rotate-6 rounded-md")} />
      </div>
    </NotchedTicket>
  );
}
