import { TicketIcon } from "lucide-react";
import styles from "./landing.module.css";

/** The hero's example: one paid request drawn as a transit ticket. Purely illustrative. */
export function FareTicket() {
  return (
    <figure className="mx-auto w-full max-w-sm">
      <div
        className={`${styles.ticket} relative overflow-hidden rounded-2xl border shadow-[0_1px_0_0_var(--border),0_24px_48px_-24px_oklch(0.3_0.02_250/0.25)]`}
      >
        <div className="space-y-5 px-6 pt-6 pb-7">
          <div className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <TicketIcon aria-hidden className="size-4" />
              BotFare
            </span>
            <span className="text-muted-foreground">Single fare</span>
          </div>

          <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-3 text-sm">
            <dt className="text-muted-foreground">From</dt>
            <dd className="min-w-0">
              <span className="font-medium">Research agent</span>
              <span className={`${styles.mono} block truncate text-xs text-muted-foreground`}>
                key ak_3f9c21e8
              </span>
            </dd>
            <dt className="text-muted-foreground">To</dt>
            <dd className="min-w-0">
              <span className="font-medium">Crema Notes</span>
              <span className={`${styles.mono} block truncate text-xs text-muted-foreground`}>
                GET /articles/burr-basics
              </span>
            </dd>
          </dl>
        </div>

        <div className="relative" aria-hidden>
          <span className={`${styles.notch} ${styles.notchLeft}`} />
          <span className={`${styles.notch} ${styles.notchRight}`} />
          <div className="mx-6 border-t-2 border-dashed border-border" />
        </div>

        <div className="space-y-4 px-6 pt-6 pb-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Fare</p>
              <p
                className={`${styles.tabular} text-5xl leading-none font-extrabold tracking-tight`}
              >
                $0.03
              </p>
            </div>
            <span
              className={`${styles.stamp} mb-1 inline-block rounded-md border-[2.5px] border-emerald-700 px-3 py-1 text-xl leading-none font-black text-emerald-700 dark:border-emerald-400 dark:text-emerald-400`}
            >
              Paid
            </span>
          </div>

          <dl
            className={`${styles.mono} ${styles.tabular} grid grid-cols-[1fr_auto] gap-y-1 text-xs text-muted-foreground`}
          >
            <dt>to publisher</dt>
            <dd className="text-foreground">$0.0285</dd>
            <dt>BotFare fee</dt>
            <dd className="text-foreground">$0.0015</dd>
            <dt>network</dt>
            <dd>paypal:sandbox</dd>
            <dt>receipt</dt>
            <dd>rcpt_9d2e41b7</dd>
          </dl>
        </div>
      </div>
      <figcaption className="mt-4 text-center text-sm text-muted-foreground">
        One paid request: 3¢ from the agent&apos;s wallet, 95% of it to the publisher.
      </figcaption>
    </figure>
  );
}
