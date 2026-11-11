"use client";

import { RECEIPT_KEYS_PATH, type StatementKind } from "@botfare/contracts/receipts";
import { AlertCircle, Loader2, SearchCheck, ShieldCheck, ShieldX } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { NewTabLink } from "@/components/app/external-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatementCard } from "./statement-card";
import { formatFareMicros } from "./statement-copy";
import {
  type CheckedStatement,
  checkStatement,
  fetchReceiptKeys,
  fetchReceiptStatements,
  parseVerifyInput,
  VerifyFetchError,
  verifyHref,
} from "./verify-lib";

const ORDER: Record<StatementKind, number> = { payment: 0, delivery: 1, refund: 2 };

interface Outcome {
  /** The receipt asked about (a lookup, or the one every pasted statement names). */
  receiptId: string | null;
  source: "lookup" | "pasted";
  statements: CheckedStatement[];
  /** Lookup only: statements BotFare has not issued for this receipt. */
  missing: StatementKind[];
  keyCount: number;
}

type State =
  | { status: "idle" }
  | { status: "checking"; label: string }
  | { status: "done"; outcome: Outcome }
  | { status: "error"; title: string; message: string };

interface ReceiptVerifierProps {
  initialReceipt: string | null;
  /** `initialReceipt` is the server's example receipt, not one the link asked for. */
  example?: boolean;
}

/** Enter a receipt ID or paste a statement; everything is verified here, in the browser. */
export function ReceiptVerifier({ initialReceipt, example = false }: ReceiptVerifierProps) {
  const [input, setInput] = useState(initialReceipt ?? "");
  const [state, setState] = useState<State>({ status: "idle" });
  const [showExample, setShowExample] = useState(example && initialReceipt !== null);
  const ran = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Only the latest check may write the result; an earlier one still in flight is dropped.
  const latest = useRef(0);

  const lookUp = useCallback(async (receiptId: string, options: { keepUrl?: boolean } = {}) => {
    const run = ++latest.current;
    const settle = (next: State) => {
      if (run === latest.current) setState(next);
    };
    setState({ status: "checking", label: `Looking up ${receiptId}` });
    // The example stays at /verify, so a reload shows the newest example.
    if (!options.keepUrl) window.history.replaceState(null, "", verifyHref(receiptId));
    try {
      const [keys, statements] = await Promise.all([
        fetchReceiptKeys(),
        fetchReceiptStatements(receiptId),
      ]);
      if (!statements) {
        settle({
          status: "error",
          title: "No such receipt",
          message: `BotFare has no receipt ${receiptId}. Check the ID or paste the statement itself.`,
        });
        return;
      }
      const slots = (["payment", "delivery", "refund"] as const).filter(
        (slot) => typeof statements[slot] === "string",
      );
      const checked = await Promise.all(
        slots.map((slot) => checkStatement(statements[slot] as string, slot, keys)),
      );
      settle({
        status: "done",
        outcome: {
          receiptId,
          source: "lookup",
          statements: checked,
          missing: (["payment", "delivery"] as const).filter((slot) => !slots.includes(slot)),
          keyCount: keys.keys.length,
        },
      });
    } catch (err) {
      settle(fetchFailure(err));
    }
  }, []);

  const verifyPasted = useCallback(
    async (tokens: { token: string; slot: StatementKind | null }[]) => {
      const run = ++latest.current;
      const settle = (next: State) => {
        if (run === latest.current) setState(next);
      };
      setState({ status: "checking", label: "Verifying" });
      try {
        const keys = await fetchReceiptKeys();
        const checked = await Promise.all(
          tokens.map(({ token, slot }) => checkStatement(token, slot, keys)),
        );
        checked.sort(
          (a, b) =>
            ORDER[(a.decoded?.kind ?? a.slot ?? "refund") as StatementKind] -
            ORDER[(b.decoded?.kind ?? b.slot ?? "refund") as StatementKind],
        );
        const subjects = new Set(checked.map((c) => c.decoded?.sub).filter(Boolean));
        const receiptId = subjects.size === 1 ? ([...subjects][0] as string) : null;
        settle({
          status: "done",
          outcome: {
            receiptId,
            source: "pasted",
            statements: checked,
            missing: [],
            keyCount: keys.keys.length,
          },
        });
      } catch (err) {
        settle(fetchFailure(err));
      }
    },
    [],
  );

  const submit = useCallback(
    (text: string, options: { keepUrl?: boolean } = {}) => {
      const parsed = parseVerifyInput(text);
      if (parsed.kind === "invalid") {
        latest.current++;
        setState({ status: "error", title: "Nothing to verify", message: parsed.message });
        return;
      }
      if (parsed.kind === "receipt") void lookUp(parsed.receiptId, options);
      else void verifyPasted(parsed.tokens);
    },
    [lookUp, verifyPasted],
  );

  useEffect(() => {
    if (ran.current || !initialReceipt) return;
    ran.current = true;
    submit(initialReceipt, { keepUrl: example });
  }, [initialReceipt, example, submit]);

  function checkYours(text: string) {
    setShowExample(false);
    submit(text);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    checkYours(input);
  }

  function checkAnother() {
    latest.current++;
    setShowExample(false);
    setInput("");
    setState({ status: "idle" });
    inputRef.current?.focus();
  }

  const checking = state.status === "checking";

  return (
    <div className="flex flex-col gap-6">
      {showExample ? (
        <ExampleBanner
          amount={state.status === "done" ? exampleAmount(state.outcome) : null}
          onCheckAnother={checkAnother}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SearchCheck aria-hidden className="size-4" />
            Check a receipt
          </CardTitle>
          <CardDescription>
            Paste a receipt ID such as <span className="font-mono">rcpt_9d2e41b7c03a5f18</span>, a
            /verify link, or the signed statements from an x402{" "}
            <span className="font-mono">PAYMENT-RESPONSE</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Label htmlFor="verify-input" className="sr-only">
              Receipt ID or signed statement
            </Label>
            <Textarea
              ref={inputRef}
              id="verify-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  checkYours(input);
                }
              }}
              placeholder="rcpt_… or eyJhbGciOiJFZERTQSIs…"
              spellCheck={false}
              autoComplete="off"
              className="max-h-48 min-h-11 font-mono text-sm"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={checking || !input.trim()}>
                {checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Verify
              </Button>
              <p className="text-xs text-muted-foreground">
                Pasted statements never leave your browser.
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <div aria-live="polite" className="flex flex-col gap-4">
        {state.status === "checking" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            {state.label}…
          </p>
        ) : null}
        {state.status === "error" ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{state.title}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
        {state.status === "done" ? (
          <Results
            outcome={state.outcome}
            onLookUp={(receiptId) => {
              setShowExample(false);
              setInput(receiptId);
              void lookUp(receiptId);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The verified price of the example's payment statement, e.g. "3¢"; null until it verifies. */
function exampleAmount(outcome: Outcome): string | null {
  for (const checked of outcome.statements) {
    const { result } = checked;
    if (
      result.ok &&
      result.statement.kind === "payment" &&
      result.statement.sub === outcome.receiptId
    ) {
      return formatFareMicros(result.statement.payment.amountMicros);
    }
  }
  return null;
}

/** Says the receipt on screen is the demo's example, with a way to clear it and check your own. */
function ExampleBanner({
  amount,
  onCheckAnother,
}: {
  amount: string | null;
  onCheckAnother: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-foreground/15 bg-ticket p-4 text-ticket-foreground sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm leading-relaxed">
        <span className="mr-2 inline-block rounded-sm border border-current px-1.5 py-px align-[0.1em] font-mono text-[0.7rem] font-semibold tracking-wider uppercase">
          Example
        </span>
        A real {amount ? `${amount} ` : ""}purchase by an agent on Crema Notes, our demo coffee
        blog.
      </p>
      <Button type="button" variant="outline" className="shrink-0" onClick={onCheckAnother}>
        Check another receipt
      </Button>
    </div>
  );
}

function fetchFailure(err: unknown): State {
  return {
    status: "error",
    title: "Could not verify",
    message: err instanceof VerifyFetchError ? err.message : "Something went wrong. Try again.",
  };
}

function Results({
  outcome,
  onLookUp,
}: {
  outcome: Outcome;
  onLookUp: (receiptId: string) => void;
}) {
  const total = outcome.statements.length;
  const valid = outcome.statements.filter(
    (c) => c.result.ok && (!outcome.receiptId || c.result.statement.sub === outcome.receiptId),
  ).length;
  const allValid = total > 0 && valid === total;

  return (
    <>
      {total === 0 ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>No signed statements for {outcome.receiptId}</AlertTitle>
          <AlertDescription>
            The receipt exists but has no signed statements. Receipts settled before BotFare started
            signing have none.
          </AlertDescription>
        </Alert>
      ) : (
        <div
          className={
            allValid
              ? "flex items-start gap-3 rounded-xl border border-emerald-600/30 bg-emerald-600/5 p-4 dark:border-emerald-400/30 dark:bg-emerald-400/5"
              : "flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
          }
        >
          {allValid ? (
            <ShieldCheck
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-400"
            />
          ) : (
            <ShieldX aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
          )}
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <p className="font-semibold">
              {allValid
                ? `${total === 1 ? "The statement" : `All ${total} statements`} verified`
                : total === 1
                  ? "The statement did not verify"
                  : `${total - valid} of ${total} statements did not verify`}
              {outcome.receiptId ? (
                <>
                  {" "}
                  for <span className="font-mono">{outcome.receiptId}</span>
                </>
              ) : null}
            </p>
            <p className="text-muted-foreground">
              Checked in your browser against the{" "}
              {outcome.keyCount === 1 ? "public key" : `${outcome.keyCount} public keys`} at{" "}
              <NewTabLink
                href={RECEIPT_KEYS_PATH}
                icon
                className="inline-flex items-center gap-0.5 rounded-sm font-mono text-xs underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [overflow-wrap:anywhere]"
              >
                {RECEIPT_KEYS_PATH}
              </NewTabLink>
              .
            </p>
            {outcome.source === "pasted" && outcome.receiptId ? (
              <button
                type="button"
                onClick={() => onLookUp(outcome.receiptId as string)}
                className="w-fit rounded-sm text-left font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Look up BotFare&apos;s latest statements for this receipt
              </button>
            ) : null}
          </div>
        </div>
      )}

      {outcome.missing.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {outcome.missing.includes("payment") ? (
            <li>No payment statement. This receipt was settled before BotFare signed payments.</li>
          ) : null}
          {outcome.missing.includes("delivery") ? (
            <li>No delivery statement yet. The site has not reported what it delivered.</li>
          ) : null}
        </ul>
      ) : null}

      {outcome.statements.map((checked) => (
        <StatementCard key={checked.token} checked={checked} receiptId={outcome.receiptId} />
      ))}
    </>
  );
}
