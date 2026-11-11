import { cn } from "cn";
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { FareTicket } from "./fare-ticket";
import styles from "./landing.module.css";
import { REPO_URL } from "./links";
import { NewTabLink } from "./new-tab-link";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="border-b">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1fr_22rem] lg:gap-16 lg:py-24">
        <div className="max-w-2xl">
          <h1
            id="hero-title"
            className="text-[2.75rem] leading-[0.98] font-extrabold tracking-[-0.03em] text-balance sm:text-6xl lg:text-7xl"
          >
            Every bot pays its <span className={styles.highlight}>fare</span>.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed sm:text-xl">
            AI agents read your site for free. BotFare charges them a few cents a page through
            PayPal. People still read free.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/judge"
              className={cn(buttonVariants({ size: "lg", className: "h-11 px-5 text-base" }))}
            >
              Try it in 2 minutes
              <ArrowRightIcon aria-hidden data-icon="inline-end" />
            </Link>
            <NewTabLink
              href={REPO_URL}
              icon={<ArrowUpRightIcon aria-hidden data-icon="inline-end" />}
              className={cn(
                buttonVariants({
                  variant: "outline",
                  size: "lg",
                  className: "h-11 border-foreground px-5 text-base",
                }),
              )}
            >
              See the code
            </NewTabLink>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            The demo uses PayPal sandbox money. No sign-up.
          </p>
        </div>
        <FareTicket />
      </div>
    </section>
  );
}
