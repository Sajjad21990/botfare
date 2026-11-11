"use client";

import {
  ArrowUpRight,
  Banknote,
  Check,
  Hourglass,
  Info,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ApiError, api, errorText } from "./api";
import {
  formatCents,
  formatClearsIn,
  formatCount,
  formatMicros,
  withdrawableCents,
} from "./format";
import { LocalTime } from "./local-time";
import type { PayoutStatusView, PayoutView, PublisherDashboard } from "./types";

// ---------------------------------------------------------------------------------------------
// Earnings and "Withdraw now"

const PAYPAL_NOT_CONFIGURED =
  "Payouts need PayPal on this server: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.";

/** The toast for a failed payout call; a missing PayPal setup gets a clear fix. */
function payoutErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === "paypal_not_configured") return PAYPAL_NOT_CONFIGURED;
  return errorText(err);
}

export function EarningsCard({
  data,
  onPayout,
}: {
  data: PublisherDashboard;
  onPayout: (payout: PayoutView) => void;
}) {
  const [withdrawing, setWithdrawing] = useState(false);
  // Only available earnings can be withdrawn; clearing fares wait out the dispute window.
  const cents = withdrawableCents(data.availableMicros);
  const clearing = data.clearingMicros > 0;
  const belowMinimum = cents < data.minimumPayoutCents;
  const reason =
    data.paypalConfigured === false
      ? PAYPAL_NOT_CONFIGURED
      : !data.payoutEmail
        ? "Add a PayPal payout email to withdraw."
        : belowMinimum
          ? `Payouts start at ${formatCents(data.minimumPayoutCents)}. You need ${formatCents(
              data.minimumPayoutCents - cents,
            )} more${clearing ? " available" : ""}.`
          : null;

  async function withdraw() {
    setWithdrawing(true);
    try {
      const { payout } = await api<{ payout: PayoutView }>("POST", "/api/publisher/payouts");
      onPayout(payout);
      const amount = formatCents(payout.amountCents);
      if (payout.reversed) {
        toast.error(`PayPal refused the payout. ${amount} is back in your earnings.`, {
          description: payout.error ?? undefined,
        });
      } else if (payout.error) {
        toast.warning(`Payout of ${amount} is queued. PayPal has not confirmed it yet.`, {
          description: "Use Refresh status in a moment; BotFare retries the same batch.",
        });
      } else {
        toast.success(`${amount} is on its way to ${payout.receiverEmail}.`, {
          description: "PayPal Payouts usually settles in sandbox within a minute.",
        });
      }
    } catch (err) {
      toast.error(payoutErrorText(err));
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Earnings</CardTitle>
        <CardDescription>
          After BotFare&apos;s 5% fee. Paid out through PayPal Payouts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-6 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Available to withdraw</div>
            <div className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
              {formatMicros(data.availableMicros)}
            </div>
            {clearing && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Hourglass className="size-3.5 shrink-0" />
                <span>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatMicros(data.clearingMicros)}
                  </span>{" "}
                  clearing
                </span>
              </div>
            )}
          </div>
          <Stat label="Lifetime earnings" value={formatMicros(data.lifetimeEarningsMicros)} />
          <Stat label="Paid requests" value={formatCount(data.paidRequests)} />
        </div>
        {clearing && <ClearingNote data={data} />}
        <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3 sm:flex-row sm:items-center">
          <Button
            size="lg"
            onClick={withdraw}
            disabled={withdrawing || reason !== null}
            className="sm:min-w-44"
          >
            {withdrawing ? <Loader2 className="animate-spin" /> : <Banknote />}
            {cents > 0 && !belowMinimum ? `Withdraw ${formatCents(cents)}` : "Withdraw now"}
          </Button>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            {reason ? (
              <>
                <Info className="mt-px size-3.5 shrink-0" />
                {reason}
              </>
            ) : (
              <>
                <ArrowUpRight className="mt-px size-3.5 shrink-0" />
                Sends to {data.payoutEmail}.{" "}
                {clearing
                  ? "Clearing fares and sub-cent amounts stay in your balance."
                  : "Sub-cent amounts stay in your balance."}
              </>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Why some earnings cannot be withdrawn yet, and when the next ones clear. */
function ClearingNote({ data }: { data: PublisherDashboard }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Hourglass className="mt-px size-3.5 shrink-0" />
      <span>
        Fares stay clearing for {data.disputeWindowHours} hours so agents can dispute them, and
        while a dispute waits for a decision.{" "}
        {data.nextReleaseAt ? (
          <>
            More clears <ClearsIn iso={data.nextReleaseAt} />.
          </>
        ) : (
          "The rest clears once its disputes are decided."
        )}
      </span>
    </p>
  );
}

/** "in 3 h 20 min", rendered after mount (and every minute) so server and browser agree. */
function ClearsIn({ iso }: { iso: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setText(formatClearsIn(iso, Date.now()));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [iso]);
  return (
    <time dateTime={iso} title={iso} className="font-medium text-foreground tabular-nums">
      {text ?? "soon"}
    </time>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 sm:border-l sm:pl-6">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-xl font-medium tabular-nums sm:pt-2">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Payout email

export function PayoutEmailCard({
  data,
  onSaved,
}: {
  data: PublisherDashboard;
  onSaved: (payoutEmail: string | null, onProfile: boolean) => void;
}) {
  const [email, setEmail] = useState(data.payoutEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unchanged =
    email.trim().toLowerCase() === (data.payoutEmail ?? "") && data.payoutEmailOnProfile;
  const inherited = Boolean(data.payoutEmail) && !data.payoutEmailOnProfile;

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ payoutEmail: string | null; payoutEmailOnProfile: boolean }>(
        "PUT",
        "/api/publisher/payout-email",
        { email: email.trim() || null },
      );
      setEmail(result.payoutEmail ?? "");
      onSaved(result.payoutEmail, result.payoutEmailOnProfile);
      toast.success(
        result.payoutEmail ? `Payouts go to ${result.payoutEmail}.` : "Payout email removed.",
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payout account</CardTitle>
        <CardDescription>The PayPal account that receives your earnings.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="payout-email">PayPal email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="payout-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-invalid={error ? true : undefined}
                readOnly={data.judgeMode}
                className="pl-8"
              />
            </div>
            <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
              {error ??
                (data.judgeMode
                  ? "Judge mode: demo payouts always go to the demo's PayPal sandbox account."
                  : inherited
                    ? "Using your first site's payout email. Save to keep it on your profile."
                    : data.payoutEmail
                      ? "Payouts and the daily run send here."
                      : "Use a PayPal sandbox personal account.")}
            </p>
          </div>
          {data.judgeMode ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" />
              Fixed for the shared demo
            </p>
          ) : (
            <Button type="submit" variant="outline" size="sm" disabled={saving || unchanged}>
              {saving ? <Loader2 className="animate-spin" /> : unchanged ? <Check /> : null}
              {unchanged ? "Saved" : "Save email"}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Payout history

const STATUS: Record<PayoutStatusView, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
  processing: {
    label: "Processing",
    className: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  success: {
    label: "Paid",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive" },
  returned: { label: "Returned", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  unclaimed: {
    label: "Unclaimed",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  reversed: { label: "Reversed", className: "bg-destructive/10 text-destructive" },
};

export function PayoutHistory({
  payouts,
  onSynced,
}: {
  payouts: PayoutView[];
  onSynced: (payouts: PayoutView[]) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const open = payouts.some(
    (p) => p.status === "pending" || p.status === "processing" || p.status === "unclaimed",
  );

  async function refresh() {
    setSyncing(true);
    try {
      const result = await api<{
        synced: number;
        errors: { batchKey: string; error: string }[];
        payouts: PayoutView[];
      }>("POST", "/api/publisher/payouts/sync");
      onSynced(result.payouts);
      if (result.errors.length > 0)
        toast.warning("PayPal did not answer for every batch. Try again shortly.");
      else if (result.synced === 0) toast.info("Every payout is already final.");
      else toast.success("Payout status refreshed from PayPal.");
    } catch (err) {
      toast.error(payoutErrorText(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payout history</CardTitle>
        <CardDescription>Each withdrawal is a PayPal Payouts batch.</CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={syncing || payouts.length === 0}
          >
            <RefreshCw className={cn(syncing && "animate-spin")} />
            Refresh status
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {payouts.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
            <Banknote className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No payouts yet</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Withdraw once you have {formatCents(100)} or more, or wait for the daily payout run.
            </p>
          </div>
        ) : (
          <>
            {open && (
              <p className="mb-3 text-xs text-muted-foreground">
                Some payouts are still open. PayPal reports the result by webhook; Refresh status
                asks it directly.
              </p>
            )}
            <div className="-mx-(--card-spacing) overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-(--card-spacing)">Amount</TableHead>
                    <TableHead>Receiver</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>PayPal batch</TableHead>
                    <TableHead className="pr-(--card-spacing) text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.map((payout) => {
                    const status = STATUS[payout.status];
                    return (
                      <TableRow key={payout.id}>
                        <TableCell className="pl-(--card-spacing) font-medium tabular-nums">
                          {formatCents(payout.amountCents)}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-muted-foreground">
                          {payout.receiverEmail}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-0.5">
                            <Badge className={status.className}>{status.label}</Badge>
                            {payout.reversed && (
                              <span className="text-[11px] text-muted-foreground">
                                Back in earnings
                              </span>
                            )}
                            {payout.status === "unclaimed" && !payout.reversed && (
                              <span className="max-w-56 text-[11px] text-muted-foreground">
                                PayPal holds it for 30 days for the receiver to claim
                              </span>
                            )}
                            {payout.error && !payout.reversed && payout.status !== "unclaimed" && (
                              <span
                                className="max-w-56 truncate text-[11px] text-muted-foreground"
                                title={payout.error}
                              >
                                {payout.error}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <code
                            className="font-mono text-xs text-muted-foreground"
                            title={`sender_batch_id ${payout.batchKey}`}
                          >
                            {payout.paypalBatchId ?? "Not yet assigned"}
                          </code>
                        </TableCell>
                        <TableCell className="pr-(--card-spacing) text-right text-muted-foreground tabular-nums">
                          <LocalTime iso={payout.createdAt} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
