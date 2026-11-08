import { LightbulbIcon } from "lucide-react";
import styles from "./landing.module.css";
import { Pillar, PillarPoints } from "./pillar";

/** Illustrative funnel for the demo's premium roundup over 14 days. */
const funnel = [
  { label: "Offers shown", count: 64 },
  { label: "Paid", count: 3 },
  { label: "Cited in an answer", count: 1 },
];

const notes = [
  { reason: "Thin listicle, not worth 50¢", count: 8 },
  { reason: "Preview lists names only", count: 5 },
];

/** The Fare Advisor example, drawn as the dashboard card. Purely illustrative. */
function AdvisorCard() {
  const max = funnel[0]?.count ?? 1;
  return (
    <figure>
      <div
        className={`${styles.ticket} overflow-hidden rounded-2xl border shadow-[0_1px_0_0_var(--border),0_24px_48px_-24px_oklch(0.3_0.02_250/0.25)]`}
      >
        <div className="px-5 pt-5">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-semibold">The premium grinder roundup</span>
            <span className={`${styles.tabular} text-muted-foreground`}>50¢</span>
          </div>
          <p className={`${styles.mono} mt-0.5 truncate text-xs text-muted-foreground`}>
            GET /articles/premium-*, last 14 days
          </p>

          <dl className={`${styles.tabular} mt-5 space-y-3 text-sm`}>
            {funnel.map((row) => (
              <div key={row.label}>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="font-bold">{row.count}</dd>
                </div>
                <span aria-hidden className="mt-1.5 block h-1.5 rounded-full bg-background">
                  <span
                    className={`${styles.bar} block h-1.5 rounded-full bg-foreground/70`}
                    style={{ width: `${(row.count / max) * 100}%` }}
                  />
                </span>
              </div>
            ))}
          </dl>

          <p className="mt-5 text-sm text-muted-foreground">Why agents declined</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {notes.map((n) => (
              <li
                key={n.reason}
                className="flex justify-between gap-4 rounded-md bg-background px-3 py-2"
              >
                <q className="min-w-0">{n.reason}</q>
                <span className={`${styles.tabular} shrink-0 text-muted-foreground`}>
                  {n.count} agents
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mt-5" aria-hidden>
          <span className={`${styles.notch} ${styles.notchLeft}`} />
          <span className={`${styles.notch} ${styles.notchRight}`} />
          <div className="mx-5 border-t-2 border-dashed border-border" />
        </div>

        <div className="px-5 pt-5 pb-5">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <LightbulbIcon aria-hidden className="size-4 text-amber-700 dark:text-amber-400" />
            Recommendation
          </p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p
                className={`${styles.tabular} text-4xl leading-none font-extrabold tracking-tight`}
              >
                <span className="text-2xl text-muted-foreground line-through decoration-2">
                  50¢
                </span>{" "}
                8¢
              </p>
              <p className={`${styles.tabular} mt-2 text-xs text-muted-foreground`}>
                Projected: $0.75 a week now, $1.20 at 8¢
              </p>
            </div>
            <span className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground">
              Apply 8¢
            </span>
          </div>
        </div>
      </div>
      <figcaption className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Illustrative figures for the demo&apos;s premium roundup. In the demo, applying 8¢ reaches
        the middleware within 30 seconds, and the next agent run buys the page.
      </figcaption>
    </figure>
  );
}

export function PillarAdvisor() {
  return (
    <Pillar
      id="fare-advisor"
      forWhom="publishers pricing their pages for AI readers"
      tinted
      example={<AdvisorCard />}
    >
      <p className="text-lg">
        A person who leaves a page doesn&apos;t say why. An agent can. Fare Advisor turns what
        agents say and do into a price, page by page.
      </p>
      <PillarPoints
        points={[
          "Agents leave free decline notes when they skip a page: a category and one sentence, such as “Preview lists names only”.",
          "Answers report which paid pages they cited. Citations are the new clicks: they replace the clicks AI summaries took away.",
          "BotFare shows the funnel for each pricing rule: offers shown, paid, declined, cited and disputed.",
          "Claude groups the reasons and recommends a price, preview or audience change. The evidence is checked against the real counts, and the projected revenue comes from BotFare’s own model, not the AI.",
          "Nothing changes until the publisher clicks Apply and confirms.",
        ]}
      />
    </Pillar>
  );
}
