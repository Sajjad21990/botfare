"use client";

import { DEMO_SITE_NAME } from "@botfare/contracts";
import type { StatementKind } from "@botfare/contracts/receipts";
import { cn } from "cn";
import {
  CircleAlert,
  FileQuestion,
  Loader2,
  SearchCheck,
  ShieldCheck,
  Ticket,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckYourCopy } from "./check-your-copy";
import { MoneySplitBar, ReceiptChecks, ReceiptTimeline, VerdictLine } from "./receipt-facts";
import {
  type ReceiptOutcome,
  type ReceiptSummary,
  summarizeReceipt,
  verdictText,
} from "./receipt-summary";
import { ReceiptTicket, TicketSkeleton } from "./receipt-ticket";
import { StatementCard } from "./statement-card";
import styles from "./verify.module.css";
import {
  checkStatement,
  fetchReceiptKeys,
  fetchReceiptStatements,
  parseVerifyInput,
  VerifyFetchError,
  verifyHref,
} from "./verify-lib";

const ORDER: Record<StatementKind, number> = { payment: 0, delivery: 1, refund: 2 };

type ErrorKind = "not_found" | "input" | "fetch";

const VERIFY_PATH = "/verify";

type State =
  | { status: "idle" }
  | { status: "checking"; label: string }
  | { status: "done"; outcome: ReceiptOutcome }
  | { status: "error"; kind: ErrorKind; title: string; message: string };

interface ReceiptVerifierProps {
  initialReceipt: string | null;
  /**
   * `initialReceipt` is the server's sample receipt, not one the link asked for. A sample only
   * fills the input: nothing is fetched or verified until the viewer presses Verify.
   */
  example?: boolean;
}

/**
 * Enter a receipt ID or paste a statement; everything is verified here, in the browser. A receipt
 * the link names (?receipt=) is verified on load; the sample waits for Verify.
 */
export function ReceiptVerifier({ initialReceipt, example = false }: ReceiptVerifierProps) {
  const sampleId = example ? initialReceipt : null;
  const [input, setInput] = useState(initialReceipt ?? "");
  const [state, setState] = useState<State>({ status: "idle" });
  // The result on screen (or being checked) is the sample's.
  const [showExample, setShowExample] = useState(false);
  const ran = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Only the latest check may write the result; an earlier one still in flight is dropped.
  const latest = useRef(0);

  const lookUp = useCallback(async (receiptId: string, options: { sample?: boolean } = {}) => {
    const run = ++latest.current;
    const settle = (next: State) => {
      if (run === latest.current) setState(next);
    };
    setState({ status: "checking", label: `Looking up ${receiptId}` });
    // The sample stays at /verify, so a reload shows the newest sample, unverified again.
    window.history.replaceState(null, "", options.sample ? VERIFY_PATH : verifyHref(receiptId));
    try {
      const [keys, statements] = await Promise.all([
        fetchReceiptKeys(),
        fetchReceiptStatements(receiptId),
      ]);
      if (!statements) {
        settle({
          status: "error",
          kind: "not_found",
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
    (text: string) => {
      const parsed = parseVerifyInput(text);
      if (parsed.kind === "invalid") {
        latest.current++;
        setShowExample(false);
        setState({
          status: "error",
          kind: "input",
          title: "Nothing to verify",
          message: parsed.message,
        });
        return;
      }
      if (parsed.kind === "receipt") {
        const sample = parsed.receiptId === sampleId;
        setShowExample(sample);
        void lookUp(parsed.receiptId, { sample });
      } else {
        setShowExample(false);
        void verifyPasted(parsed.tokens);
      }
    },
    [lookUp, verifyPasted, sampleId],
  );

  // A receipt the link names is checked at once; the sample waits for Verify.
  useEffect(() => {
    if (ran.current || !initialReceipt || example) return;
    ran.current = true;
    submit(initialReceipt);
  }, [initialReceipt, example, submit]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!checking) submit(input);
  }

  function checkAnother() {
    latest.current++;
    setShowExample(false);
    setInput("");
    setState({ status: "idle" });
    // The address no longer names the receipt that was on screen.
    window.history.replaceState(null, "", VERIFY_PATH);
    inputRef.current?.focus();
  }

  const checking = state.status === "checking";
  const inputError = state.status === "error" && state.kind === "input" ? state.message : null;
  const sampleReady = sampleId !== null && state.status === "idle" && input.trim() === sampleId;
  const summary = useMemo(
    () => (state.status === "done" ? summarizeReceipt(state.outcome) : null),
    [state],
  );

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby="check-title"
        className="rounded-xl border border-foreground/15 bg-card p-4 sm:p-5"
      >
        <h2 id="check-title" className="flex items-center gap-2 text-lg font-bold">
          <SearchCheck aria-hidden className="size-5" />
          Check a receipt
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Paste a receipt ID such as{" "}
          <span className="font-mono whitespace-nowrap">rcpt_9d2e41b7c03a5f18</span>, a /verify
          link, or the signed statements from an x402{" "}
          <span className="font-mono whitespace-nowrap">PAYMENT-RESPONSE</span>.
        </p>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
          <Label htmlFor="verify-input" className="sr-only">
            Receipt ID or signed statement
          </Label>
          <Textarea
            ref={inputRef}
            id="verify-input"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (inputError) setState({ status: "idle" });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!checking) submit(input);
              }
            }}
            placeholder="rcpt_… or eyJhbGciOiJFZERTQSIs…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={inputError ? true : undefined}
            aria-describedby="verify-input-note"
            className="max-h-48 min-h-10 flex-1 bg-background font-mono text-sm"
          />
          {/* Always pressable unless a check is running; an empty input gets a note, not a dead button.
              While it runs the button keeps keyboard focus (aria-disabled) and full opacity. */}
          <Button
            type="submit"
            disabled={checking}
            focusableWhenDisabled
            className="h-10 px-4 aria-disabled:pointer-events-none sm:w-28"
          >
            {checking ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <ShieldCheck />
            )}
            {checking ? "Checking" : "Verify"}
          </Button>
        </form>
        <div id="verify-input-note" className="mt-2.5 min-h-5">
          {inputError ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-stamp">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {inputError}
            </p>
          ) : sampleReady ? (
            <p className="flex items-start gap-2 text-sm leading-relaxed">
              <Ticket aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                This is a real receipt from {DEMO_SITE_NAME}, our demo recipe blog. Press Verify to
                check it.
              </span>
            </p>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              Pasted statements never leave your browser.
            </p>
          )}
        </div>
      </section>

      <p role="status" className="sr-only">
        {state.status === "checking"
          ? `${state.label}…`
          : summary
            ? `${verdictText(summary)}${summary.receiptId ? ` Receipt ${summary.receiptId}.` : ""}`
            : ""}
      </p>

      {state.status === "checking" ? (
        <Loading sample={showExample} onCheckAnother={checkAnother} />
      ) : null}
      {state.status === "error" && state.kind !== "input" ? (
        <ErrorPanel kind={state.kind} title={state.title} message={state.message} />
      ) : null}
      {state.status === "done" && summary ? (
        <Results
          outcome={state.outcome}
          summary={summary}
          sample={showExample}
          onCheckAnother={checkAnother}
          onLookUp={(receiptId) => {
            setInput(receiptId);
            submit(receiptId);
          }}
        />
      ) : null}
    </div>
  );
}

function fetchFailure(err: unknown): State {
  return {
    status: "error",
    kind: "fetch",
    title: "Could not verify",
    message: err instanceof VerifyFetchError ? err.message : "Something went wrong. Try again.",
  };
}

/**
 * Says the receipt on screen is the demo's sample, with a way to clear it and check your own. The
 * amount appears once the payment statement has verified.
 */
function SampleStrip({
  summary,
  onCheckAnother,
}: {
  summary: ReceiptSummary | null;
  onCheckAnother: () => void;
}) {
  const amount = summary?.payment ? summary.split?.amount : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border-[1.5px] border-dashed border-foreground/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm leading-relaxed">
        This sample is a real {amount ? `${amount} ` : ""}purchase on {DEMO_SITE_NAME}, our demo
        recipe blog.
      </p>
      <Button type="button" variant="outline" className="shrink-0" onClick={onCheckAnother}>
        Check another receipt
      </Button>
    </div>
  );
}

function Loading({ sample, onCheckAnother }: { sample: boolean; onCheckAnother: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      {sample ? <SampleStrip summary={null} onCheckAnother={onCheckAnother} /> : null}
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,22.5rem)_minmax(0,1fr)] md:gap-8">
        <div className="flex flex-col gap-4">
          <TicketSkeleton />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Checking the signatures in your browser…
          </p>
        </div>
        <div aria-hidden className="flex flex-col gap-3">
          <div className={cn(styles.pulse, "h-6 w-40 rounded-md")} />
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className="flex items-center gap-3 rounded-xl border border-foreground/10 bg-card px-3 py-3"
            >
              <div className={cn(styles.pulse, "size-7 rounded-full")} />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className={cn(styles.pulse, "h-3.5 w-1/3 rounded-md")} />
                <div className={cn(styles.pulse, "h-3 w-2/3 rounded-md")} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorPanel({ kind, title, message }: { kind: ErrorKind; title: string; message: string }) {
  const Icon = kind === "not_found" ? FileQuestion : TriangleAlert;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border-[1.5px] border-stamp/50 bg-card p-4"
    >
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-stamp" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {message}
        </p>
      </div>
    </div>
  );
}

function Results({
  outcome,
  summary,
  sample,
  onCheckAnother,
  onLookUp,
}: {
  outcome: ReceiptOutcome;
  summary: ReceiptSummary;
  sample: boolean;
  onCheckAnother: () => void;
  onLookUp: (receiptId: string) => void;
}) {
  const isSample = sample && summary.receiptId !== null;

  if (summary.total === 0) {
    return (
      <div className="flex flex-col gap-6">
        {isSample ? <SampleStrip summary={summary} onCheckAnother={onCheckAnother} /> : null}
        <div className="flex items-start gap-3 rounded-xl border-[1.5px] border-foreground/20 bg-card p-4">
          <FileQuestion aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-semibold [overflow-wrap:anywhere]">
              No signed statements for {outcome.receiptId}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The receipt exists but has no signed statements. Receipts settled before BotFare
              started signing have none.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        {isSample ? <SampleStrip summary={summary} onCheckAnother={onCheckAnother} /> : null}
        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,22.5rem)_minmax(0,1fr)] md:gap-8">
          <section aria-labelledby="receipt-title" className="flex flex-col gap-4">
            <h2 id="receipt-title" className="sr-only">
              Receipt{summary.receiptId ? ` ${summary.receiptId}` : ""}
            </h2>
            <ReceiptTicket
              summary={summary}
              sample={isSample}
              siteName={isSample ? DEMO_SITE_NAME : null}
            />
            <VerdictLine summary={summary} keyCount={outcome.keyCount} />
            {outcome.source === "pasted" && outcome.receiptId ? (
              <button
                type="button"
                onClick={() => onLookUp(outcome.receiptId as string)}
                className="w-fit rounded-sm text-left text-sm font-medium underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              >
                Look up BotFare&apos;s latest statements for this receipt
              </button>
            ) : null}
          </section>
          <div className="flex flex-col gap-6">
            <ReceiptChecks checks={summary.checks} trusted={summary.trusted} />
            <MoneySplitBar summary={summary} />
          </div>
        </div>
      </div>

      {summary.trusted && summary.timeline.length > 0 ? (
        <ReceiptTimeline items={summary.timeline} />
      ) : null}

      <section aria-labelledby="statements-title" className="flex flex-col gap-3">
        <div>
          <h2 id="statements-title" className="text-lg font-bold">
            Signed statements
          </h2>
          <p className="text-sm text-muted-foreground">
            Every field BotFare signed, and the raw JWS your browser checked.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {outcome.statements.map((checked) => (
            <StatementCard
              key={checked.token}
              checked={checked}
              receiptId={outcome.receiptId}
              trusted={summary.trusted}
            />
          ))}
          {summary.delivery ? <CheckYourCopy statement={summary.delivery} /> : null}
        </div>
        {outcome.missing.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {outcome.missing.includes("payment") ? (
              <li>
                No payment statement. This receipt was settled before BotFare signed payments.
              </li>
            ) : null}
            {outcome.missing.includes("delivery") ? (
              <li>
                No delivery statement for this receipt. The site has not reported what it sent.
              </li>
            ) : null}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
