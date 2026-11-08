import { cn } from "cn";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { FareTicket } from "./fare-ticket";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="border-b">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1fr_24rem] lg:gap-20">
        <div className="max-w-2xl">
          <h1
            id="hero-title"
            className="text-5xl leading-[0.95] font-extrabold tracking-[-0.035em] text-balance sm:text-7xl lg:text-[5.5rem]"
          >
            Every bot pays its fare.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Pay-per-request for AI agents, settled on PayPal — x402 for PayPal&apos;s 440 million
            accounts.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/signin"
              className={cn(buttonVariants({ size: "lg", className: "h-11 px-5 text-base" }))}
            >
              Try the demo
            </Link>
            <a
              href="#how-it-works"
              className={cn(
                buttonVariants({
                  variant: "outline",
                  size: "lg",
                  className: "h-11 px-5 text-base",
                }),
              )}
            >
              See how it works
            </a>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Runs in the PayPal sandbox. Pick a demo role; no password needed.
          </p>
        </div>
        <FareTicket />
      </div>
    </section>
  );
}
