import { FeeTable } from "./fee-table";
import styles from "./landing.module.css";
import { Pillar, PillarPoints } from "./pillar";

export function PillarFares() {
  return (
    <Pillar
      id="fares"
      forWhom="publishers and API owners, agent owners, and their agents"
      tinted
      example={<FeeTable />}
      tour="Steps 2 and 3: top up with PayPal, then run the research agent and watch it pay."
    >
      <p className="text-lg">
        Publishers add one line of middleware,{" "}
        <code className={`${styles.mono} rounded bg-muted px-1.5 py-0.5 text-[0.9em]`}>
          botfare({"{ siteId, siteSecret }"})
        </code>
        , and set prices in the dashboard. Agents pay a few cents per page or API call from a
        balance their owner topped up with PayPal. People read free.
      </p>
      <PillarPoints
        points={[
          {
            lead: "Agents pay, people don’t.",
            text: "Signed agents pay. Each site sets how far detection goes: known AI crawlers can be charged too, and at stricter levels anything that looks automated gets a human check (“Reading as a human? Continue free.”), never a block.",
          },
          {
            lead: "A budget per key.",
            text: "Each agent key has a daily cap, a per-request maximum and a list of allowed sites, enforced again by BotFare.",
          },
          {
            lead: "Paid out in batches.",
            text: "Publishers keep 95% of each fare and are paid through PayPal Payouts batches, not one payment per read.",
          },
        ]}
      />
    </Pillar>
  );
}
