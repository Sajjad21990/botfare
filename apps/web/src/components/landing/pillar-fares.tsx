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
          "Standard x402 V2 with a new payment type, scheme prepaid on network paypal:sandbox, as a plug-in for the official SDK.",
          "Signed agents and known AI crawlers pay. Anything else that only looks automated gets a human check (“Reading as a human? Continue free.”), never a block.",
          "Each agent key has a daily cap, a per-request maximum and a list of allowed sites, enforced again by BotFare.",
          "Publishers keep 95% of each fare and are paid in PayPal Payouts batches, not one payment per read.",
        ]}
      />
    </Pillar>
  );
}
