import { CheckIcon, ScaleIcon } from "lucide-react";
import styles from "./landing.module.css";
import { Pillar, PillarPoints } from "./pillar";

/** The Fare Court example: the demo's stub dispute, drawn as a claim slip. Purely illustrative. */
function DisputeSlip() {
  return (
    <figure>
      <div
        className={`${styles.ticket} overflow-hidden rounded-2xl border shadow-[0_1px_0_0_var(--border),0_24px_48px_-24px_oklch(0.3_0.02_250/0.25)]`}
      >
        <div className="flex items-center justify-between gap-4 px-5 pt-5 text-sm">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <ScaleIcon aria-hidden className="size-4" />
            Fare Court
          </span>
          <span className={`${styles.mono} truncate text-xs text-muted-foreground`}>
            dispute on rcpt_4c1a77f0
          </span>
        </div>

        <div className="grid gap-px px-5 pt-5 sm:grid-cols-2">
          <div className="rounded-t-lg bg-background p-4 sm:rounded-l-lg sm:rounded-tr-none">
            <p className="text-xs text-muted-foreground">Declared offer, 3¢</p>
            <p className="mt-1.5 font-semibold leading-snug">Grinder maintenance, step by step</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              A ten-minute monthly routine: brushing the burrs, clearing the chute, checking
              alignment…
            </p>
          </div>
          <div className="rounded-b-lg bg-background p-4 sm:rounded-r-lg sm:rounded-bl-none">
            <p className="text-xs text-muted-foreground">Delivered after payment</p>
            <p className="mt-1.5 font-semibold leading-snug">Subscribe to keep reading</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              This article is for subscribers. Subscribe for $9 a month to read the full guide.
            </p>
          </div>
        </div>

        <dl
          className={`${styles.mono} grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-5 pt-4 text-xs text-muted-foreground`}
        >
          <dt>bytes</dt>
          <dd className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
            <CheckIcon
              aria-hidden
              className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400"
              strokeWidth={3}
            />
            <span className="truncate">matches the attested digest</span>
          </dd>
          <dt>verdict</dt>
          <dd className="text-foreground">refund, 93% sure</dd>
          <dt>category</dt>
          <dd>stub_or_paywall</dd>
        </dl>

        <div className="relative mt-5" aria-hidden>
          <span className={`${styles.notch} ${styles.notchLeft}`} />
          <span className={`${styles.notch} ${styles.notchRight}`} />
          <div className="mx-5 border-t-2 border-dashed border-border" />
        </div>

        <div className="flex items-end justify-between gap-4 px-5 pt-5 pb-5">
          <div>
            <p className="text-sm text-muted-foreground">Back to the agent&apos;s wallet</p>
            <p className={`${styles.tabular} text-4xl leading-none font-extrabold tracking-tight`}>
              $0.03
            </p>
          </div>
          <span className="mb-1 inline-block -rotate-6 rounded-md border-[2.5px] border-emerald-700 px-2.5 py-1 text-lg leading-none font-black text-emerald-700 dark:border-emerald-400 dark:text-emerald-400">
            Refunded
          </span>
        </div>
      </div>
      <figcaption className="mt-4 text-sm leading-relaxed text-muted-foreground">
        The demo case on the fictional Crema Notes: a 3¢ guide with a real preview, served to paying
        agents as a subscribe wall. With an Anthropic key the 3¢ comes back in seconds.
      </figcaption>
    </figure>
  );
}

export function PillarCourt() {
  return (
    <Pillar
      id="fare-court"
      forWhom="agent owners, who get bad purchases back, and publishers, who decide the close calls"
      example={<DisputeSlip />}
    >
      <p className="text-lg">
        PayPal-style buyer protection, for purchases too small for a person to dispute. No one files
        a claim over 3¢, so an agent does it, and Claude reads the evidence.
      </p>
      <PillarPoints
        points={[
          "The publisher declares the offer (title and preview) in the payment terms, and after the response its middleware attests a SHA-256 digest of the exact bytes it delivered.",
          "Within 24 hours the agent disputes with the bytes it got, signed with its key. If they don’t match the digest, the dispute is invalid: the agent can’t fake content, and the publisher can’t deny it.",
          "Claude compares the declared offer with the delivered text and returns a verdict with a confidence and its reasons.",
          "Code decides from there: a refund verdict at 80% confidence or more is paid at once (one refund per receipt, ever, within the key’s dispute limits). Anything less certain goes to the publisher’s Disputes page with the AI’s reasoning.",
        ]}
      />
    </Pillar>
  );
}
