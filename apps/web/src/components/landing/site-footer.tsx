import { cn } from "cn";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function SiteFooter() {
  return (
    <footer>
      <div className="mx-auto w-full max-w-6xl px-4 pt-20 pb-10 sm:px-6 sm:pt-28">
        <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-end">
          <p className="text-5xl leading-[0.95] font-extrabold tracking-[-0.035em] sm:text-7xl">
            Pay the fare, pal.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/signin"
              className={cn(buttonVariants({ size: "lg", className: "h-11 px-5 text-base" }))}
            >
              Try the demo
            </Link>
            <Link
              href="/judge"
              className={cn(
                buttonVariants({
                  variant: "outline",
                  size: "lg",
                  className: "h-11 px-5 text-base",
                }),
              )}
            >
              Take the two-minute tour
            </Link>
          </div>
        </div>
        <div className="mt-16 flex flex-col gap-2 border-t pt-6 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <p>BotFare runs in the PayPal sandbox only. No real money moves.</p>
          <p>Built for the PayPal AI Hackathon, November 2026. MIT licensed.</p>
        </div>
      </div>
    </footer>
  );
}
