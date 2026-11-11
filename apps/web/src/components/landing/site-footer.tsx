import { cn } from "cn";
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { buttonVariants } from "@/components/ui/button";
import styles from "./landing.module.css";
import { LICENSE_URL, REPO_URL } from "./links";
import { NewTabLink } from "./new-tab-link";

const fine = `${styles.focusRing} rounded-sm underline underline-offset-4 hover:text-foreground`;

const smallArrow = <ArrowUpRightIcon aria-hidden className="ml-px inline size-3 align-[-0.05em]" />;

export function SiteFooter() {
  return (
    <footer>
      <div className="mx-auto w-full max-w-6xl px-4 pt-16 pb-10 sm:px-6 sm:pt-24">
        <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
          <p className="flex items-center gap-3 font-heading text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-7xl">
            <BotFareMark className="size-12 sm:size-16" />
            Pay the fare, pal.
          </p>
          <Link
            href="/judge"
            className={cn(buttonVariants({ size: "lg", className: "h-11 px-5 text-base" }))}
          >
            Try it in 2 minutes
            <ArrowRightIcon aria-hidden data-icon="inline-end" />
          </Link>
        </div>
        <div className="mt-14 flex flex-col gap-2 border-t pt-6 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <p>PayPal sandbox only. No real money moves.</p>
          <p>
            Built for the PayPal AI Hackathon, November 2026 ·{" "}
            <NewTabLink href={LICENSE_URL} className={fine} icon={smallArrow}>
              MIT
            </NewTabLink>
            {" · "}
            <NewTabLink href={REPO_URL} className={fine} icon={smallArrow}>
              Source
            </NewTabLink>
            {" · "}
            <Link href="/privacy" className={fine}>
              Privacy
            </Link>
            {" · "}
            <Link href="/terms" className={fine}>
              Terms
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
