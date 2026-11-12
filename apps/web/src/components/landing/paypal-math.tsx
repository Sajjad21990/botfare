import styles from "./landing.module.css";
import { readmeUrl } from "./links";
import { NewTabLink } from "./new-tab-link";

/** $5.00 at 2¢ a recipe; one PayPal payment per page would cost 250 fees of about 49¢ each. */
const PAGES_PER_TOP_UP = 250;

const apis = ["PayPal Checkout", "Payouts", "Webhooks", "Log in with PayPal", "x402", "MCP"];

const linkClass = `${styles.focusRing} inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded-sm font-semibold underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`;

/** One row of the fee picture: a green dollar sign per PayPal fee. */
function FeeRow({ label, count, fees }: { label: string; count: string; fees: number }) {
  return (
    <div>
      <p className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-semibold">{label}</span>
        <span className={`${styles.tabular} whitespace-nowrap`}>{count}</span>
      </p>
      <div aria-hidden className="mt-2.5 flex flex-wrap gap-x-1 gap-y-0.5">
        {Array.from({ length: fees }, (_, i) => `fee-${i}`).map((id) => (
          <span
            key={id}
            className="flex h-4 w-2.5 items-center justify-center text-[15px] leading-none font-extrabold text-success"
          >
            $
          </span>
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
          <h2
            id="paypal-title"
            className="font-heading text-5xl leading-none font-extrabold tracking-tight sm:text-6xl"
          >
            1 fee, not {PAGES_PER_TOP_UP}.
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-relaxed">
            A PayPal payment for a 2¢ recipe would cost about 49¢ in fees. A $5 top-up covers{" "}
            {PAGES_PER_TOP_UP} pages.
          </p>
          <p className="mt-4 max-w-xl leading-relaxed">
            BotFare adds PayPal to x402, an open protocol for AI agent payments.
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
          <p className="mt-8">
            <NewTabLink href={readmeUrl("how-a-paid-request-works")} className={linkClass}>
              How a paid request works
            </NewTabLink>
          </p>
        </div>

        <div className="space-y-6 self-center rounded-2xl border bg-card p-6">
          <FeeRow
            label="A payment per page"
            count={`${PAGES_PER_TOP_UP} fees`}
            fees={PAGES_PER_TOP_UP}
          />
          <div aria-hidden className="border-t-2 border-dashed" />
          <FeeRow label="One $5 top-up" count="1 fee" fees={1} />
        </div>
      </div>
    </section>
  );
}
