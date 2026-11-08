import { CheckIcon } from "lucide-react";
import styles from "./landing.module.css";

const costs = [
  {
    cost: "The technical cost",
    fix: "x402",
    body: "A payment is one HTTP header on the request. No checkout page, no account per site.",
  },
  {
    cost: "PayPal’s fee",
    fix: "BotFare’s batching",
    body: "One fee on a $5.00 top-up instead of one on every 3¢ read, and one Payouts batch for a day’s earnings.",
  },
  {
    cost: "The decision cost",
    fix: "AI",
    body: "Is this page worth 3¢? Was it what was promised? What should it cost? Claude decides; code moves the money.",
  },
];

export function Thesis() {
  return (
    <section aria-labelledby="thesis-title" className="border-b bg-muted/40">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[20rem_1fr] lg:gap-20">
        <div>
          <h2
            id="thesis-title"
            className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
          >
            Micropayments failed on the decision, not the technology.
          </h2>
          <p className="mt-4 max-w-[60ch] leading-relaxed text-muted-foreground">
            For more than 25 years, every tiny payment has asked for a decision that costs more
            attention than the payment is worth: Nick Szabo,{" "}
            <a
              href="https://nakamotoinstitute.org/micropayments-and-mental-transaction-costs/"
              className={`${styles.focusRing} rounded-sm text-foreground underline underline-offset-4`}
            >
              &ldquo;Micropayments and Mental Transaction Costs&rdquo;
            </a>{" "}
            (1999); Clay Shirky, &ldquo;The Case Against Micropayments&rdquo; (2000).
          </p>
        </div>
        <dl className="divide-y self-start border-y">
          {costs.map((c) => (
            <div
              key={c.cost}
              className="grid gap-x-8 gap-y-2 py-6 sm:grid-cols-[minmax(0,14rem)_1fr]"
            >
              <dt>
                <span className="block text-muted-foreground line-through decoration-2 decoration-foreground/40">
                  {c.cost}
                </span>
                <span className="mt-1 inline-flex items-center gap-1.5 text-xl font-bold tracking-tight">
                  <CheckIcon
                    aria-hidden
                    className="size-5 text-emerald-700 dark:text-emerald-400"
                    strokeWidth={2.5}
                  />
                  <span>
                    <span className="sr-only">removed by </span>
                    {c.fix}
                  </span>
                </span>
              </dt>
              <dd className="max-w-[56ch] leading-relaxed text-muted-foreground">{c.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
