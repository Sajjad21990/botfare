"use client";

import { AlertCircle, KeyRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  DEFAULT_BUDGET_CENTS,
  MAX_PER_REQUEST_CENTS,
  type ResearchAvailability,
} from "@/lib/server/research-events";
import { AnswerCard } from "./answer-card";
import { CostMeter } from "./cost-meter";
import { QuestionCard, SUGGESTED_QUESTIONS } from "./question-card";
import { isInspectable } from "./run-state";
import { Timeline } from "./timeline";
import { fetchAvailability, useResearchRun } from "./use-research-run";
import { WireInspector } from "./wire-inspector";

/** The research agent demo: ask, watch it buy (or refuse), inspect the wire, read the answer. */
export function ResearchView() {
  const [question, setQuestion] = useState(SUGGESTED_QUESTIONS[0] ?? "");
  const [budgetCents, setBudgetCents] = useState(DEFAULT_BUDGET_CENTS);
  const [availability, setAvailability] = useState<ResearchAvailability | null>(null);
  const { view, start, stop } = useResearchRun(DEFAULT_BUDGET_CENTS);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const answerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetchAvailability().then((result) => {
      if (live) setAvailability(result);
    });
    return () => {
      live = false;
    };
  }, []);

  const inspectable = useMemo(() => view.entries.filter(isInspectable), [view.entries]);
  const receipts = useMemo(
    () => view.entries.filter((entry) => entry.kind === "payment").length,
    [view.entries],
  );

  // Follow the latest payment or refusal (or offer, before any) until the viewer picks one.
  useEffect(() => {
    if (!follow) return;
    const latest =
      [...inspectable].reverse().find((entry) => entry.kind !== "offer") ??
      inspectable[inspectable.length - 1];
    setSelected(latest?.toolCallId ?? null);
  }, [follow, inspectable]);

  useEffect(() => {
    if (view.answer) answerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [view.answer]);

  const running = view.status === "running" || view.status === "starting";
  const selectedEntry =
    [...inspectable]
      .reverse()
      .find((entry) => entry.kind !== "offer" && entry.toolCallId === selected) ??
    inspectable.find((entry) => entry.toolCallId === selected) ??
    null;

  function select(toolCallId: string) {
    setFollow(false);
    setSelected(toolCallId);
  }

  function showReceipt(receiptId: string) {
    const payment = view.entries.find(
      (entry) => entry.kind === "payment" && entry.receiptId === receiptId,
    );
    if (payment && payment.kind === "payment") {
      select(payment.toolCallId);
      document
        .getElementById("wire-inspector")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function run() {
    setFollow(true);
    setSelected(null);
    void start(question.trim(), budgetCents);
  }

  const unavailable = availability && !availability.available ? availability : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Research agent</h1>
        <p className="text-sm text-muted-foreground">
          A Claude agent with a BotFare key and a budget. It pays per page over x402, settled from a
          PayPal-funded wallet, and shows its work.
        </p>
      </div>

      {unavailable ? (
        <Alert>
          <KeyRound />
          <AlertTitle>The research agent is not set up on this server</AlertTitle>
          <AlertDescription>
            {unavailable.message}
            {unavailable.missing?.length ? (
              <span className="mt-1 block font-mono text-xs">
                Missing: {unavailable.missing.join(", ")}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <QuestionCard
            question={question}
            onQuestionChange={setQuestion}
            budgetCents={running ? view.budgetCents : budgetCents}
            onBudgetChange={setBudgetCents}
            maxPerRequestCents={view.maxPerRequestCents || MAX_PER_REQUEST_CENTS}
            running={running}
            disabled={!availability || Boolean(unavailable)}
            onRun={run}
            onStop={stop}
          />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-2">
          <CostMeter
            view={view.status === "idle" ? { ...view, budgetCents } : view}
            receipts={receipts}
          />
          {view.status !== "idle" && view.question ? (
            <p className="line-clamp-3 px-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Question:</span> {view.question}
            </p>
          ) : null}
        </div>
      </div>

      {view.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>
            {view.status === "stopped" ? "The run stopped early" : "The run failed"}
          </AlertTitle>
          <AlertDescription>{view.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-3">
          {view.answer ? (
            <div ref={answerRef} className="scroll-mt-6">
              <AnswerCard
                answer={view.answer.answer}
                citations={view.answer.citations}
                spentCents={view.spentCents}
                budgetCents={view.budgetCents}
                onShowReceipt={showReceipt}
              />
            </div>
          ) : null}
          <Timeline view={view} selected={selected} onSelect={select} />
        </div>
        <div id="wire-inspector" className="min-w-0 scroll-mt-6 lg:sticky lg:top-6 lg:col-span-2">
          <WireInspector
            entry={selectedEntry}
            trace={selected ? (view.wire[selected] ?? null) : null}
          />
        </div>
      </div>
    </div>
  );
}
