import { ArrowUpRightIcon } from "lucide-react";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import styles from "./landing.module.css";
import { DEMO_RECIPE_URL } from "./links";
import { NewTabLink } from "./new-tab-link";
import { NotchedTicket } from "./notched-ticket";

/**
 * The hero's example: one paid page drawn as a printed ticket. The figures are illustrative; the
 * page link is the real demo recipe, which reads free in a browser.
 */
export function FareTicket() {
  return (
    <figure
      aria-label="A research agent paid Saffron & Salt 2¢ for one recipe"
      className="mx-auto w-full max-w-sm lg:rotate-2"
    >
      <NotchedTicket>
        <div className="space-y-5 px-6 pt-5 pb-6">
          <div className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-heading font-extrabold">
              <BotFareMark className="size-6" />
              BotFare
            </span>
            <span className="font-medium tracking-wide text-muted-foreground uppercase">
              Receipt
            </span>
          </div>

          <dl className="grid grid-cols-[4rem_1fr] items-baseline gap-x-3 gap-y-3">
            <dt className="text-sm text-muted-foreground">Paid by</dt>
            <dd className="text-lg font-semibold">Research agent</dd>
            <dt className="text-sm text-muted-foreground">Paid to</dt>
            <dd className="min-w-0">
              <span className="block text-lg font-semibold whitespace-nowrap">
                Saffron &amp; Salt
              </span>
              <NewTabLink
                href={DEMO_RECIPE_URL}
                icon={<ArrowUpRightIcon aria-hidden className="ml-0.5 inline size-3.5" />}
                className={`${styles.focusRing} inline-flex items-center rounded-sm text-sm font-medium whitespace-nowrap underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`}
              >
                Lentil dal recipe
              </NewTabLink>
            </dd>
          </dl>
        </div>

        <div
          aria-hidden
          data-perforation
          className="mx-6 border-t-2 border-dashed border-foreground/35"
        />

        <div className="flex items-end justify-between gap-4 px-6 pt-5 pb-6">
          <div>
            <p className="text-sm text-muted-foreground">Fare</p>
            <p
              className={`${styles.tabular} font-heading text-6xl leading-none font-extrabold tracking-tight`}
            >
              2¢
            </p>
          </div>
          <span
            className={`${styles.stamp} mb-1 inline-block rounded-md border-[3px] border-[#146b3f] px-3 py-1 font-heading text-2xl leading-none font-extrabold tracking-wider text-[#146b3f] uppercase`}
          >
            Paid
          </span>
        </div>

        <p className="border-t-[1.5px] border-dashed border-foreground/35 px-6 py-3 text-sm font-medium">
          <span className="block">The site keeps 95%.</span>{" "}
          <span className="block">Agents have 24 hours to dispute.</span>
        </p>
      </NotchedTicket>
    </figure>
  );
}
