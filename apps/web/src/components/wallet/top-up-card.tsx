"use client";

import { cn } from "cn";
import { AlertCircle, Loader2, LockKeyhole, RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatMoney } from "./format";
import { loadPayPalSdk, type PayPalOneTimePaymentSession, type PayPalSdkError } from "./paypal-sdk";
import { type CaptureResponse, TOP_UP_CHOICES_CENTS, type TopUpCents } from "./types";

type SdkState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "ineligible" }
  | { kind: "error"; message: string };

/** Every top-up toast shares one ID, so a newer state replaces the older one. */
const TOAST_ID = "wallet-top-up";

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Server-side order creation; the browser only ever sends the chosen amount. */
async function createOrder(amountCents: TopUpCents): Promise<{ orderId: string }> {
  const res = await fetch("/api/wallet/topups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountCents }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { orderId: string };
}

/**
 * Top up with the PayPal JS SDK v6: pick $5, $10 or $20, approve in PayPal, and the server
 * captures the order and credits the wallet. `clientId` is null when PAYPAL_CLIENT_ID is unset.
 */
export function TopUpCard({ clientId }: { clientId: string | null }) {
  const router = useRouter();
  const [amount, setAmount] = useState<TopUpCents>(500);
  const [sdk, setSdk] = useState<SdkState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const sessionRef = useRef<PayPalOneTimePaymentSession | null>(null);
  const amountRef = useRef(amount);
  amountRef.current = amount;

  const onApprove = useCallback(
    async ({ orderId }: { orderId: string }) => {
      setCapturing(true);
      toast.loading("Confirming your payment with PayPal…", { id: TOAST_ID });
      try {
        const res = await fetch(`/api/wallet/topups/${encodeURIComponent(orderId)}/capture`, {
          method: "POST",
        });
        if (!res.ok) {
          toast.error("We could not confirm this top-up", {
            id: TOAST_ID,
            description: await readError(res),
          });
          return;
        }
        const result = (await res.json()) as CaptureResponse;
        if (result.status === "captured") {
          const gross = result.grossCents ?? 0;
          const fee = result.feeCents ?? 0;
          toast.success(`${formatCents(gross)} added to your wallet`, {
            id: TOAST_ID,
            duration: 10_000,
            description: `PayPal's ${formatCents(fee)} fee is paid by BotFare, so all ${formatCents(gross)} is yours to spend. Wallet balance: ${formatMoney(result.walletMicros)}.`,
          });
        } else if (result.status === "pending") {
          toast.info("PayPal is still clearing this payment", {
            id: TOAST_ID,
            description: "Your balance updates by itself as soon as PayPal completes it.",
          });
        } else {
          toast.error("PayPal declined the payment", {
            id: TOAST_ID,
            description: "No money moved. Try again with a different funding source.",
          });
        }
        router.refresh();
      } catch {
        toast.error("We could not reach BotFare", {
          id: TOAST_ID,
          description: "If PayPal took the payment, your balance updates automatically shortly.",
        });
      } finally {
        setCapturing(false);
        setOpen(false);
      }
    },
    [router],
  );

  // `attempt` re-runs the setup when the user presses Retry after a failed load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    setSdk({ kind: "loading" });
    (async () => {
      try {
        const paypal = await loadPayPalSdk();
        const instance = await paypal.createInstance({
          clientId,
          components: ["paypal-payments"],
          pageType: "checkout",
        });
        const methods = await instance.findEligibleMethods({ currencyCode: "USD" });
        if (cancelled) return;
        if (!methods.isEligible("paypal")) {
          setSdk({ kind: "ineligible" });
          return;
        }
        const session = instance.createPayPalOneTimePaymentSession({
          onApprove,
          onCancel: () => {
            setOpen(false);
            toast("Top-up cancelled", { id: TOAST_ID, description: "No money moved." });
          },
          onError: (error: PayPalSdkError) => {
            setOpen(false);
            toast.error("PayPal could not finish the payment", {
              id: TOAST_ID,
              description: error.message || error.code || "Please try again.",
            });
          },
        });
        sessionRef.current = session;
        setSdk({ kind: "ready" });
        // Redirect flows (some mobile browsers) come back to this page; finish them here.
        if (session.hasReturned?.()) await session.resume?.();
      } catch (err) {
        if (!cancelled) {
          setSdk({
            kind: "error",
            message: err instanceof Error ? err.message : "The PayPal SDK did not load",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      sessionRef.current = null;
    };
  }, [clientId, onApprove, attempt]);

  function startPayment() {
    const session = sessionRef.current;
    if (!session || open || capturing) return;
    setOpen(true);
    // Start synchronously inside the click so the popup is not blocked; pass the order promise.
    session
      .start({ presentationMode: "auto" }, createOrder(amountRef.current))
      .catch((err: unknown) => {
        toast.error("Could not start the PayPal payment", {
          id: TOAST_ID,
          description: err instanceof Error ? err.message : "Please try again.",
        });
      })
      .finally(() => setOpen(false));
  }

  const busy = open || capturing;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Top up</CardTitle>
        <CardDescription>
          Pay with PayPal. The money is in your wallet as soon as PayPal confirms the payment.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5">
        <div role="radiogroup" aria-label="Top-up amount" className="grid grid-cols-3 gap-2">
          {TOP_UP_CHOICES_CENTS.map((cents) => {
            const selected = cents === amount;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control styled as buttons
              <button
                key={cents}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy}
                onClick={() => setAmount(cents)}
                className={cn(
                  "h-12 rounded-lg border text-base font-semibold tabular-nums transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
                  selected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background hover:bg-muted",
                )}
              >
                {formatCents(cents).replace(".00", "")}
              </button>
            );
          })}
        </div>

        <div className="mt-auto space-y-3">
          {!clientId ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>PayPal is not configured</AlertTitle>
              <AlertDescription>
                Set <code className="font-mono text-xs">PAYPAL_CLIENT_ID</code> and{" "}
                <code className="font-mono text-xs">PAYPAL_CLIENT_SECRET</code> (a sandbox REST app)
                in <code className="font-mono text-xs">.env</code>, then restart the app.
              </AlertDescription>
            </Alert>
          ) : sdk.kind === "loading" ? (
            <Skeleton className="h-11 w-full rounded-full" aria-label="Loading PayPal" />
          ) : sdk.kind === "ineligible" ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>PayPal is not available here</AlertTitle>
              <AlertDescription>
                PayPal reports this browser is not eligible for checkout. Try another browser.
              </AlertDescription>
            </Alert>
          ) : sdk.kind === "error" ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>PayPal did not load</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{sdk.message}. Check your connection or ad blocker.</p>
                <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  <RotateCw /> Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="relative">
              <paypal-button
                type="pay"
                className="paypal-gold"
                onClick={startPayment}
                aria-disabled={busy}
                style={{ display: "block", width: "100%", opacity: busy ? 0.5 : 1 }}
              />
              {capturing ? (
                <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-full bg-background/80 text-sm font-medium">
                  <Loader2 className="size-4 animate-spin" /> Confirming…
                </div>
              ) : null}
            </div>
          )}

          {!clientId ? (
            <Button disabled className="h-11 w-full rounded-full">
              Pay {formatCents(amount)} with PayPal
            </Button>
          ) : null}

          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
            <LockKeyhole className="size-3" />
            You pay {formatCents(amount)}, your wallet gets {formatCents(amount)}. PayPal sandbox:
            test money, nothing real is charged.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
