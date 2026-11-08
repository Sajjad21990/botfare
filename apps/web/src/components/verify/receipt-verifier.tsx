"use client";

import { RECEIPT_KEYS_PATH, type StatementKind } from "@botfare/contracts/receipts";
import { AlertCircle, Loader2, SearchCheck, ShieldCheck, ShieldX } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatementCard } from "./statement-card";
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

/** Enter a receipt ID or paste a statement; everything is verified here, in the browser. */
export function ReceiptVerifier({ initialReceipt }: { initialReceipt: string | null }) {
  const [input, setInput] = useState(initialReceipt ?? "");
  const [state, setState] = useState<State>({ status: "idle" });
  const ran = useRef(false);

  const lookUp = useCallback(async (receiptId: string) => {
    setState({ status: "checking", label: `Looking up ${receiptId}` });
    window.history.replaceState(null, "", verifyHref(receiptId));
    try {
      const [keys, statements] = await Promise.all([
        fetchReceiptKeys(),
        fetchReceiptStatements(receiptId),
      ]);
      if (!statements) {
        setState({
          status: "error",
          title: "No such receipt",
          message: `BotFare has no receipt ${receiptId}. Check the ID, or paste the signed statement itself.`,
        });
        return;
      }
      const slots = (["payment", "delivery", "refund"] as const).filter(
        (slot) => typeof statements[slot] === "string",
      );
      const checked = await Promise.all(
        slots.map((slot) => checkStatement(statements[slot] as string, slot, keys)),
      );
      setState({
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
      setState(fetchFailure(err));
    }
  }, []);

  const verifyPasted = useCallback(
    async (tokens: { token: string; slot: StatementKind | null }[]) => {
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
        setState({
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
        setState(fetchFailure(err));
      }
    },
    [],
  );

  const submit = useCallback(
    (text: string) => {
      const parsed = parseVerifyInput(text);
      if (parsed.kind === "invalid") {
        setState({ status: "error", title: "Nothing to verify", message: parsed.message });
        return;
      }
      if (parsed.kind === "receipt") void lookUp(parsed.receiptId);
      else void verifyPasted(parsed.tokens);
    },
    [lookUp, verifyPasted],
  );

  useEffect(() => {
    if (ran.current || !initialReceipt) return;
    ran.current = true;
    submit(initialReceipt);
  }, [initialReceipt, submit]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit(input);
  }

  const checking = state.status === "checking";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SearchCheck aria-hidden className="size-4" />
            Check a receipt
          </CardTitle>
          <CardDescription>
            A receipt ID such as <span className="font-mono">rcpt_9d2e41b7c03a5f18</span>, or one or
            more signed statements (compact JWS) pasted from an agent, an MCP result or an x402{" "}
            <span className="font-mono">PAYMENT-RESPONSE</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Label htmlFor="verify-input" className="sr-only">
              Receipt ID or signed statement
            </Label>
            <Textarea
              id="verify-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(input);
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
                Verified in your browser with BotFare&apos;s public key. Nothing you paste is sent
                anywhere.
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
              setInput(receiptId);
              void lookUp(receiptId);
            }}
          />
        ) : null}
      </div>
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
            The receipt exists, but BotFare has not signed a statement for it. Receipts settled
            before signed receipts were turned on have none.
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
              Verified in your browser with BotFare&apos;s public key, from{" "}
              <a
                href={RECEIPT_KEYS_PATH}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs underline underline-offset-4"
              >
                {RECEIPT_KEYS_PATH}
              </a>{" "}
              ({outcome.keyCount} {outcome.keyCount === 1 ? "key" : "keys"}).
            </p>
            {outcome.source === "pasted" && outcome.receiptId ? (
              <button
                type="button"
                onClick={() => onLookUp(outcome.receiptId as string)}
                className="w-fit text-left font-medium underline underline-offset-4"
              >
                Fetch BotFare&apos;s latest statements for this receipt
              </button>
            ) : null}
          </div>
        </div>
      )}

      {outcome.missing.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {outcome.missing.includes("payment") ? (
            <li>No payment statement: this receipt was settled before BotFare signed payments.</li>
          ) : null}
          {outcome.missing.includes("delivery") ? (
            <li>
              No delivery statement yet: the publisher has not attested the bytes it delivered.
            </li>
          ) : null}
        </ul>
      ) : null}

      {outcome.statements.map((checked) => (
        <StatementCard key={checked.token} checked={checked} receiptId={outcome.receiptId} />
      ))}
    </>
  );
}
