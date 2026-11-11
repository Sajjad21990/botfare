import { DEMO_SITE_NAME, DEMO_SITE_PRICING, type PricingRule } from "@botfare/contracts";
import { DISPUTE_POLICY } from "@botfare/contracts/fare";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { FareAdvisorMark } from "@/components/brand/fare-advisor-mark";
import { FareCourtMark } from "@/components/brand/fare-court-mark";
import { Stamp } from "./ai-cards";
import { type FlowStep, HowFlow } from "./how-flow";
import styles from "./landing.module.css";
import { NewTabLink } from "./new-tab-link";

/* One 2¢ recipe from price to payout. The figures are the demo's real ones: prices from
   DEMO_SITE_PRICING, the seeded research key's limits (10¢ a page, $10.00 a day), the dal recipe's
   title and the start of its 402 preview (apps/demo previewFor: the article's lead, not the
   front-matter excerpt), DISPUTE_POLICY's window, the 95/5 split, and the cookbook
   decline from the seeded Fare Advisor story. */

/** Short names for Saffron & Salt's priced paths. */
const PRICE_LABELS: Record<string, string> = {
  "/recipes/*": "Recipes",
  "/techniques/*": "Technique guides",
  "/meal-plans/*": "Meal plans",
  "/cookbook/*": "Cookbook chapters",
  "/api/nutrition": "Nutrition API",
};

/** Agent prices cheapest first, then the ones everyone pays. */
const priceRows: PricingRule[] = DEMO_SITE_PRICING.filter(
  (rule) => rule.pattern in PRICE_LABELS,
).sort((a, b) =>
  a.audience === b.audience ? a.priceCents - b.priceCents : a.audience === "everyone" ? 1 : -1,
);

const SUCCESS_ON_TICKET = "text-[#146b3f]";

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 max-w-prose leading-relaxed text-pretty">{children}</p>;
}

function PriceList() {
  return (
    <ul className="max-w-sm divide-y-[1.5px] divide-dashed divide-foreground/25 rounded-lg border-[1.5px] border-foreground bg-ticket px-3.5 text-sm">
      {priceRows.map((rule) => (
        <li key={rule.pattern} className="flex items-baseline gap-2 py-2">
          <span className="font-medium">{PRICE_LABELS[rule.pattern]}</span>
          {rule.audience === "everyone" ? (
            <span className="text-xs text-muted-foreground">for everyone</span>
          ) : null}
          <span
            className={`${styles.tabular} ml-auto font-heading text-base font-extrabold whitespace-nowrap`}
          >
            {rule.priceCents}¢
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A few lines of HTTP, wrapped rather than scrolled on a phone. */
function Wire({ children }: { children: ReactNode }) {
  return (
    <pre
      className={`${styles.mono} max-w-md rounded-lg bg-foreground px-2.5 py-2.5 text-[0.65rem] leading-relaxed break-all whitespace-pre-wrap text-background sm:px-3 sm:text-xs`}
    >
      <code>{children}</code>
    </pre>
  );
}

function Offer() {
  return (
    <div className="max-w-md overflow-hidden rounded-lg border-[1.5px] border-foreground bg-card text-sm">
      <p className={`${styles.mono} bg-foreground px-3 py-1.5 text-xs text-brand`}>
        402 Payment Required
      </p>
      <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5">
        <dt className="text-muted-foreground">Price</dt>
        <dd className="font-semibold">2¢</dd>
        <dt className="text-muted-foreground">Page</dt>
        <dd className="font-medium">Weeknight red lentil dal that freezes well</dd>
        <dt className="text-muted-foreground">Preview</dt>
        <dd>
          Split red lentils need no soaking and collapse into a creamy dal in about 20 minutes…
        </dd>
      </dl>
    </div>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      {children}
    </li>
  );
}

function Decision() {
  return (
    <div className="max-w-md rounded-lg border-[1.5px] border-foreground bg-card px-3.5 py-3 text-sm">
      <ul className="space-y-1.5">
        <Check>Worth 2¢ for this question</Check>
        <Check>Under its 10¢ a page limit</Check>
        <Check>Under its $10.00 daily limit</Check>
      </ul>
      <div className="mt-3 flex items-center gap-3 border-t-[1.5px] border-dashed border-foreground/25 pt-3">
        <span aria-hidden>
          <Stamp small className="border-success text-success">
            Buy
          </Stamp>
        </span>
        <span className="font-medium">Signs a payment for exactly 2¢.</span>
      </div>
    </div>
  );
}

function MiniReceipt() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="w-60 rounded-lg border-[1.5px] border-foreground bg-ticket text-sm">
        <div className="flex items-center justify-between px-3 pt-2.5">
          <span className="inline-flex items-center gap-1.5 font-heading font-extrabold">
            <BotFareMark className="size-5" />
            BotFare
          </span>
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Receipt
          </span>
        </div>
        <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2">
          <dt className="text-muted-foreground">Paid to</dt>
          <dd className="font-semibold">{DEMO_SITE_NAME}</dd>
          <dt className="text-muted-foreground">Fare</dt>
          <dd className="font-semibold">2¢</dd>
        </dl>
        <p
          className={`flex gap-4 border-t-[1.5px] border-dashed border-foreground/35 px-3 py-2 font-semibold ${SUCCESS_ON_TICKET}`}
        >
          <span className="inline-flex items-center gap-1">
            Paid <CheckIcon aria-hidden className="size-4" />
          </span>
          <span className="inline-flex items-center gap-1">
            Delivered <CheckIcon aria-hidden className="size-4" />
          </span>
        </p>
      </div>
      <NewTabLink
        href="/verify"
        className={`${styles.focusRing} inline-flex items-center gap-1 rounded-sm font-semibold underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`}
      >
        See a real receipt
      </NewTabLink>
    </div>
  );
}

function Fork() {
  return (
    <div className="grid max-w-xl gap-3 text-pretty sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="self-start rounded-lg border-[1.5px] border-foreground/30 bg-card px-3.5 py-3">
        <p className="font-heading text-lg font-extrabold text-success">Yes</p>
        <p className="mt-1">Done. The payment stands.</p>
      </div>
      <div className="rounded-lg border-[1.5px] border-foreground bg-card px-3.5 py-3">
        <p className="font-heading text-lg font-extrabold text-stamp">No</p>
        <p className="mt-1">The agent disputes it within {DISPUTE_POLICY.windowHours} hours.</p>
        <p className="mt-2.5 flex items-start gap-2.5">
          <FareCourtMark className="size-9" />
          <span>
            <strong>Fare Court</strong> compares the promise with what arrived. If it is{" "}
            {DISPUTE_POLICY.autoRefundConfidence * 100}% sure the agent is right, the 2¢ comes back
            at once. Unclear cases go to the site.
          </span>
        </p>
      </div>
    </div>
  );
}

function Split() {
  return (
    <div className="max-w-md text-sm">
      <div
        aria-hidden
        className="flex h-8 overflow-hidden rounded-lg border-[1.5px] border-foreground"
      >
        <div className="flex-[95] bg-brand" />
        <div className="flex-[5] border-l-[1.5px] border-foreground bg-foreground" />
      </div>
      <div className={`${styles.tabular} mt-2 flex justify-between gap-4`}>
        <p>
          <strong className="block">{DEMO_SITE_NAME}</strong>
          95%, 1.9¢
        </p>
        <p className="text-right">
          <strong className="block">BotFare</strong>
          5%, 0.1¢
        </p>
      </div>
    </div>
  );
}

function Suggestion() {
  return (
    <div className="flex max-w-xl flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="rounded-lg border-[1.5px] border-foreground/30 bg-card px-3.5 py-2.5 text-sm">
        <p className="text-xs font-medium text-muted-foreground">
          Why agents skipped a cookbook chapter
        </p>
        <p className="mt-0.5 font-semibold">Thin list, not worth 50¢</p>
      </div>
      <ArrowRightIcon aria-hidden className="ml-4 size-5 shrink-0 rotate-90 sm:ml-0 sm:rotate-0" />
      <div className="flex items-center gap-3 rounded-lg border-[1.5px] border-foreground bg-ticket px-3.5 py-2.5">
        <FareAdvisorMark className="size-9" />
        <span className={`${styles.tabular} font-heading font-extrabold`}>
          <span className="block text-xs font-medium text-muted-foreground">Suggested price</span>
          <s className="text-foreground/60 decoration-stamp decoration-2">50¢</s>{" "}
          <span className="text-2xl">8¢</span>
        </span>
        <span
          aria-hidden
          className="rounded-md bg-foreground px-2.5 py-1 text-xs font-semibold text-brand"
        >
          Apply
        </span>
      </div>
    </div>
  );
}

const steps: FlowStep[] = [
  {
    actor: "Site",
    title: "The site sets its prices.",
    detail: (
      <>
        <PriceList />
        <Note>Agents pay per page. People reading the site are never charged.</Note>
      </>
    ),
  },
  {
    actor: "Agent",
    title: "An AI agent asks for a page.",
    detail: (
      <>
        <Wire>
          <span className="text-brand">GET</span> /recipes/weeknight-red-lentil-dal{"\n"}
          <span className="text-background/60">Host:</span> botfare-demo.onrender.com
        </Wire>
        <Note>A person reads this page free. BotFare on the site sees an agent.</Note>
      </>
    ),
  },
  {
    actor: "Site",
    title: "The site replies 402 Payment Required.",
    detail: (
      <>
        <Offer />
        <Note>Reading the offer is free.</Note>
      </>
    ),
  },
  {
    actor: "Agent",
    title: "The agent decides, then pays.",
    detail: (
      <>
        <Decision />
        <Note>
          Its owner topped up with PayPal and set these limits. Code enforces them, not the AI. If
          the agent skips a page, it can say why (step 8).
        </Note>
      </>
    ),
  },
  {
    actor: "BotFare",
    title: "The page arrives with a signed receipt.",
    detail: (
      <>
        <MiniReceipt />
        <Note>
          The agent is charged only after the page arrives. BotFare signs the receipt, so anyone can
          check it.
        </Note>
      </>
    ),
  },
  {
    actor: "Agent",
    title: "Was it what the preview promised?",
    detail: <Fork />,
  },
  {
    actor: "BotFare",
    title: "The money settles.",
    detail: (
      <>
        <Split />
        <Note>
          Earnings clear after the {DISPUTE_POLICY.windowHours}-hour dispute window. Then the site
          withdraws them to PayPal.
        </Note>
      </>
    ),
  },
  {
    actor: "BotFare",
    title: "Fare Advisor suggests a new price.",
    detail: (
      <>
        <Suggestion />
        <Note>Nothing changes until the site clicks Apply.</Note>
      </>
    ),
  },
];

/** How it works: the eight steps of one paid page, on a rail the visitor can open or play. */
export function HowSteps() {
  return (
    <section id="how" aria-labelledby="how-title" className={`${styles.anchor} border-b`}>
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <HowFlow
          steps={steps}
          header={
            <>
              <h2 id="how-title" className="text-3xl leading-tight font-extrabold sm:text-4xl">
                How it works
              </h2>
              <p className="mt-3 text-lg leading-relaxed">One 2¢ recipe, from price to payout.</p>
            </>
          }
        />
      </div>
    </section>
  );
}
