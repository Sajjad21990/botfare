import { cn } from "cn";
import { ArrowUpRightIcon, CheckIcon, ShieldCheckIcon } from "lucide-react";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { VerifyMark } from "@/components/brand/verify-mark";
import { buttonVariants } from "@/components/ui/button";
import styles from "./landing.module.css";
import { NewTabLink } from "./new-tab-link";

function ReceiptLine({ label, fare }: { label: string; fare?: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="font-semibold">
        {label}
        {fare ? (
          <span className={`${styles.tabular} ml-1.5 font-heading text-lg font-extrabold`}>
            {fare}
          </span>
        ) : null}
      </span>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success text-white">
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </span>
    </li>
  );
}

/** A small receipt in /verify's style. Decorative: the section's words say the same thing. */
function ReceiptSketch() {
  return (
    <div
      aria-hidden
      className={`${styles.printed} w-full max-w-72 justify-self-start rounded-2xl bg-ticket text-sm md:justify-self-end`}
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <span className="inline-flex items-center gap-1.5 font-heading font-extrabold">
          <BotFareMark className="size-5" />
          BotFare
        </span>
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Receipt
        </span>
      </div>
      <div className="mx-5 border-t-2 border-dashed border-foreground/35" />
      <ul className="space-y-2.5 px-5 py-4">
        <ReceiptLine label="Paid" fare="2¢" />
        <ReceiptLine label="Delivered" />
      </ul>
      <div className="mx-5 border-t-2 border-dashed border-foreground/35" />
      <div className="px-5 pt-3 pb-4">
        {/* /verify's PAID green, darker than --success so it holds 4.5:1 on ticket stock. */}
        <span className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-[#146b3f] bg-card px-2.5 py-1 text-xs font-semibold text-[#146b3f]">
          <ShieldCheckIcon className="size-3.5" strokeWidth={2.5} />
          Signature valid
        </span>
      </div>
    </div>
  );
}

/** Signed receipts, right after How it works: what BotFare signs and where anyone can check one. */
export function VerifySection() {
  return (
    <section id="receipts" aria-labelledby="receipts-title" className={`${styles.anchor} border-b`}>
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 sm:py-16 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-16">
        <div>
          <h2
            id="receipts-title"
            className="flex items-center gap-3 text-2xl leading-tight font-extrabold text-balance sm:text-3xl"
          >
            <VerifyMark className="size-10 shrink-0 sm:size-12 md:size-11 lg:size-12" />
            Every fare comes with a signed receipt
          </h2>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-pretty">
            BotFare signs what each agent paid and what each site delivered. Anyone can check a
            receipt in their own browser with BotFare&apos;s public key, without trusting
            BotFare&apos;s servers.
          </p>
          <NewTabLink
            href="/verify"
            icon={<ArrowUpRightIcon aria-hidden data-icon="inline-end" />}
            className={cn(buttonVariants({ size: "lg", className: "mt-6 h-11 px-5 text-base" }))}
          >
            Check a real receipt
          </NewTabLink>
        </div>
        <ReceiptSketch />
      </div>
    </section>
  );
}
