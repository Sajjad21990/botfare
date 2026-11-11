import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import styles from "./landing.module.css";
import { readmeUrl } from "./links";

/** $5.00 at 3¢ a page; one PayPal payment per page would cost 166 fees of about 49¢ each. */
const PAGES_PER_TOP_UP = 166;

const apis = ["PayPal Checkout", "Payouts", "Webhooks", "Log in with PayPal", "x402", "MCP"];

const linkClass = `${styles.focusRing} inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded-sm font-semibold underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`;

/** One row of the fee picture: a dot per PayPal fee. */
function FeeRow({ label, fees }: { label: string; fees: number }) {
  return (
    <div>
      <p className="text-sm font-semibold">{label}</p>
      <div aria-hidden className="mt-2.5 flex flex-wrap gap-1">
        {Array.from({ length: fees }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical dots, never reordered
          <span key={i} className="size-2.5 rounded-[3px] bg-chart-4" />
        ))}
      </div>
    </div>
  );
}

export function PaypalMath() {
  return (
    <section aria-labelledby="paypal-title" className="border-b">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[1fr_26rem] lg:gap-16">
        <div>
          <h2 id="paypal-title" className="text-3xl leading-tight font-extrabold sm:text-4xl">
            Built on PayPal, sized for cents
          </h2>
          <p className="mt-6 font-heading text-5xl leading-none font-extrabold tracking-tight sm:text-6xl">
            1 fee, not {PAGES_PER_TOP_UP}.
          </p>
          <p className="mt-6 max-w-xl text-lg leading-relaxed">
            One PayPal payment per 3¢ page would cost about 49¢ in fees. One $5.00 top-up covers
            about {PAGES_PER_TOP_UP} pages.
          </p>
          <p className="mt-4 max-w-xl leading-relaxed">
            BotFare adds PayPal to x402, the open standard for AI agent payments.
          </p>
          <ul aria-label="Built with" className="mt-6 flex flex-wrap gap-2">
            {apis.map((api) => (
              <li
                key={api}
                className="rounded-full border-[1.5px] border-foreground/80 bg-card px-3 py-1 text-sm font-medium"
              >
                {api}
              </li>
            ))}
          </ul>
          <p className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:gap-x-8">
            <Link href="/verify" className={linkClass}>
              Verify a signed receipt
              <ArrowRightIcon aria-hidden className="size-4" />
            </Link>
            <a href={readmeUrl("how-a-paid-request-works")} className={linkClass}>
              How it works in depth
              <ArrowRightIcon aria-hidden className="size-4" />
            </a>
          </p>
        </div>

        <div className="space-y-6 self-center rounded-2xl border bg-card p-6">
          <FeeRow
            label={`Paying PayPal page by page: ${PAGES_PER_TOP_UP} fees`}
            fees={PAGES_PER_TOP_UP}
          />
          <div aria-hidden className="border-t-2 border-dashed" />
          <FeeRow label="Paying through BotFare: 1 fee on a $5.00 top-up" fees={1} />
        </div>
      </div>
    </section>
  );
}
