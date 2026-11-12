import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatCents, formatMoney, formatMoneyExact } from "./format";
import { LocalTime } from "./local-time";
import type { WalletTopUp } from "./types";

/** Balance, today's spend, how the fees work, and the latest top-ups. */
export function BalanceCard({
  balanceMicros,
  spendTodayMicros,
  activeKeys,
  topups,
  demoWallet = false,
}: {
  balanceMicros: number;
  spendTodayMicros: number;
  activeKeys: number;
  topups: WalletTopUp[];
  /** The agent-owner demo persona, whose wallet is kept at $5.00 of test money. */
  demoWallet?: boolean;
}) {
  const recent = topups.slice(0, 3);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardDescription>Wallet balance</CardDescription>
        <CardTitle
          className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl"
          title={formatMoneyExact(balanceMicros)}
        >
          {formatMoney(balanceMicros)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5">
        <dl className="grid grid-cols-2 gap-4 sm:max-w-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Spent today</dt>
            <dd
              className="text-lg font-medium tabular-nums"
              title={formatMoneyExact(spendTodayMicros)}
            >
              {formatMoney(spendTodayMicros)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Active agent keys</dt>
            <dd className="text-lg font-medium tabular-nums">{activeKeys}</dd>
          </div>
        </dl>

        <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
          Your AI agents pay each page&apos;s price from this balance. The website keeps 95%,
          BotFare 5%.
        </p>

        <div className="mt-auto">
          <Separator className="mb-3" />
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Recent top-ups</h3>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {demoWallet
                ? "None yet. The demo wallet starts with $5.00 of test money; add more with PayPal."
                : "None yet. Top up with PayPal to get your AI agents going."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {recent.map((topup) => (
                <li key={topup.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    <LocalTime iso={topup.createdAt} />
                  </span>
                  <span className="text-right">
                    <span className="font-medium tabular-nums">
                      +{formatCents(topup.grossCents)}
                    </span>
                    <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
                      PayPal fee {formatCents(topup.feeCents)} paid by BotFare
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
