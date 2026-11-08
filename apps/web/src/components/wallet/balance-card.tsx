import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatCents, formatMicros } from "./format";
import { LocalTime } from "./local-time";
import type { WalletTopUp } from "./types";

/** Balance, today's spend, how the fees work, and the latest top-ups. */
export function BalanceCard({
  balanceMicros,
  spendTodayMicros,
  activeKeys,
  topups,
}: {
  balanceMicros: number;
  spendTodayMicros: number;
  activeKeys: number;
  topups: WalletTopUp[];
}) {
  const recent = topups.slice(0, 3);
  return (
    <Card className="h-full">
      <CardHeader>
        <CardDescription>Available balance</CardDescription>
        <CardTitle className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
          {formatMicros(balanceMicros)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5">
        <dl className="grid grid-cols-2 gap-4 sm:max-w-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Spent today</dt>
            <dd className="text-lg font-medium tabular-nums">{formatMicros(spendTodayMicros)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Active agent keys</dt>
            <dd className="text-lg font-medium tabular-nums">{activeKeys}</dd>
          </div>
        </dl>

        <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
          Agents pay each page&apos;s listed price from this balance: the publisher keeps 95%,
          BotFare 5%. PayPal&apos;s top-up fee is on us, so a $10 top-up is $10.00 to spend.
        </p>

        <div className="mt-auto">
          <Separator className="mb-3" />
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Recent top-ups</h3>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet. Add funds with PayPal to get your agents going.
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
