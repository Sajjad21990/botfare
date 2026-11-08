import type { Metadata } from "next";
import { AgentKeysCard } from "@/components/wallet/agent-keys-card";
import { BalanceCard } from "@/components/wallet/balance-card";
import { DisputesCard } from "@/components/wallet/disputes-card";
import { ReceiptsCard } from "@/components/wallet/receipts-card";
import { TopUpCard } from "@/components/wallet/top-up-card";
import { getDb } from "@/lib/server/db";
import { getOwnerDisputes, OWNER_DISPUTE_LIMIT } from "@/lib/server/fare-court-api";
import { paypalClientId } from "@/lib/server/paypal";
import { requireUser } from "@/lib/server/session";
import { getWalletView, WALLET_RECEIPT_LIMIT } from "@/lib/server/wallet";

export const metadata: Metadata = { title: "Wallet · BotFare" };
export const dynamic = "force-dynamic";

/** The agent owner's wallet: balance and PayPal top-up, agent keys with budgets, receipts. */
export default async function Page() {
  const user = await requireUser();
  const [view, disputes] = await Promise.all([
    getWalletView(getDb(), user.id),
    getOwnerDisputes(user.id),
  ]);
  const activeKeys = view.keys.filter((key) => key.status === "active").length;
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
        <p className="text-sm text-muted-foreground">
          Fund your agents with PayPal and give each one a key with its own budget.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <BalanceCard
            balanceMicros={view.balanceMicros}
            spendTodayMicros={view.spendTodayMicros}
            activeKeys={activeKeys}
            topups={view.topups}
          />
        </div>
        <div className="lg:col-span-2">
          <TopUpCard clientId={paypalClientId()} />
        </div>
      </div>

      <AgentKeysCard keys={view.keys} sites={view.sites} />
      <ReceiptsCard receipts={view.receipts} limit={WALLET_RECEIPT_LIMIT} />
      <DisputesCard disputes={disputes} limit={OWNER_DISPUTE_LIMIT} />
    </div>
  );
}
