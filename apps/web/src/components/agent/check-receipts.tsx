"use client";

import { ArrowDown, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { NewTabLink } from "@/components/app/external-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { verifyHref } from "@/components/verify/verify-href";
import { cn } from "@/lib/utils";
import { formatFare, shortPath } from "./format";
import { VERIFY_SOURCES_ID, type VerifySourcesCheck, VerifySummary } from "./verify-sources";

/** One paid page from the run (a payment in the timeline). */
export interface PaidReceipt {
  receiptId: string;
  url: string;
  title: string | null;
  amountCents: number;
}

/** Where the cost meter's Receipts count scrolls to. */
export const CHECK_RECEIPTS_ID = "check-receipts";

interface CheckReceiptsProps {
  receipts: PaidReceipt[];
  /** The answer's Verify sources check; null when the run ended without an answer. */
  verify: VerifySourcesCheck | null;
}

/**
 * The next step after a run that paid for pages: check its receipts without trusting BotFare.
 * The button runs the answer's Verify sources check; each receipt also opens on /verify.
 */
export function CheckReceipts({ receipts, verify }: CheckReceiptsProps) {
  const state = verify?.state ?? { status: "idle" as const };
  const canVerify = Boolean(verify?.available);
  const first = receipts[0];

  async function check() {
    if (!verify) return;
    const finished = await verify.run();
    if (finished) scrollToResults();
  }

  return (
    <section
      id={CHECK_RECEIPTS_ID}
      aria-labelledby="check-receipts-title"
      className="flex scroll-mt-6 flex-col gap-4 rounded-xl border-[1.5px] border-foreground bg-ticket p-4 text-ticket-foreground shadow-[4px_4px_0_var(--foreground)] sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ticket-foreground bg-brand text-brand-foreground">
          <ShieldCheck aria-hidden className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="check-receipts-title" className="text-lg font-semibold tracking-tight">
            Check the receipts yourself
          </h2>
          <p className="text-sm text-[#5c5344]">
            Every page the agent paid for has a receipt signed by BotFare. Anyone can check it,
            without trusting us.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {canVerify ? (
          <Button
            type="button"
            size="lg"
            onClick={() => void check()}
            disabled={state.status === "checking"}
            className="h-10 px-4 text-[0.95rem]"
          >
            {state.status === "checking" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            {state.status === "checking"
              ? "Checking signatures"
              : state.status === "done"
                ? "Verify again"
                : "Verify sources"}
          </Button>
        ) : first ? (
          <NewTabLink
            href={verifyHref(first.receiptId)}
            className={cn(buttonVariants({ size: "lg" }), "h-10 px-4 text-[0.95rem]")}
          >
            <ShieldCheck aria-hidden />
            Open the receipt in /verify
          </NewTabLink>
        ) : null}
        {state.status === "done" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <VerifySummary rows={state.rows} live={false} className="[&_span]:text-[#5c5344]" />
            <button
              type="button"
              onClick={scrollToResults}
              className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
            >
              See each check
              <ArrowDown aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : state.status === "error" ? (
          <p role="alert" className="text-sm font-medium text-stamp">
            {state.message}
          </p>
        ) : canVerify ? (
          <p className="text-xs text-[#5c5344]">
            Runs in your browser with BotFare&apos;s public key: paid, delivered, bytes match.
          </p>
        ) : null}
      </div>

      <ul className="flex flex-col gap-1.5 border-t border-dashed border-ticket-foreground/40 pt-3 text-sm">
        {receipts.map((receipt) => (
          <li key={receipt.receiptId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <NewTabLink
              href={verifyHref(receipt.receiptId)}
              className="inline-flex min-w-0 items-baseline gap-1 font-medium underline-offset-4 hover:underline"
            >
              <span className="min-w-0">
                Open receipt <span className="break-all font-mono">{receipt.receiptId}</span> in
                /verify
              </span>
              <ExternalLink aria-hidden className="size-3 shrink-0 self-center" />
            </NewTabLink>
            <span className="min-w-0 max-w-full truncate text-xs text-[#5c5344]">
              {formatFare(receipt.amountCents)} · {receipt.title ?? shortPath(receipt.url)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function scrollToResults() {
  // After React renders the rows.
  requestAnimationFrame(() =>
    document
      .getElementById(VERIFY_SOURCES_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
  );
}
