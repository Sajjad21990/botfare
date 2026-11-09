"use client";

import { Loader2, Play, Square } from "lucide-react";
import { type FormEvent, type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_BUDGET_CENTS,
  MAX_QUESTION_CHARS,
  MIN_BUDGET_CENTS,
} from "@/lib/server/research-events";
import { formatFare } from "./format";

export const SUGGESTED_QUESTIONS = [
  "Which home grinder under $200 should I buy, and how do I dial in espresso with it?",
  "How do burr grinders differ, and does burr shape matter for pour-over?",
  "What dose, yield and grind should I start with for an 18 g espresso shot?",
];

interface QuestionCardProps {
  question: string;
  onQuestionChange: (question: string) => void;
  budgetCents: number;
  onBudgetChange: (cents: number) => void;
  maxPerRequestCents: number;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
  onStop: () => void;
  /** The provider and model picker, when the server offers a choice. */
  modelPicker?: ReactNode;
}

/** The question, a few suggestions, the budget slider and Run / Stop. */
export function QuestionCard(props: QuestionCardProps) {
  const questionId = useId();
  const budgetId = useId();
  const canRun = !props.disabled && !props.running && props.question.trim().length >= 3;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canRun) props.onRun();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask the research agent</CardTitle>
        <CardDescription>
          It reads free previews, pays the fare only for pages worth it, and cites its receipts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={questionId}>Question</Label>
            <Textarea
              id={questionId}
              value={props.question}
              maxLength={MAX_QUESTION_CHARS}
              rows={3}
              placeholder="Ask something the coffee sites on BotFare can answer"
              disabled={props.running}
              onChange={(event) => props.onQuestionChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
              }}
            />
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_QUESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={props.running}
                  onClick={() => props.onQuestionChange(suggestion)}
                  className="rounded-full border px-3 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>

          {props.modelPicker}

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor={budgetId}>Budget</Label>
                <span className="text-sm font-medium tabular-nums">
                  {formatFare(props.budgetCents)}
                </span>
              </div>
              <input
                id={budgetId}
                type="range"
                min={MIN_BUDGET_CENTS}
                max={MAX_BUDGET_CENTS}
                step={5}
                value={props.budgetCents}
                disabled={props.running}
                onChange={(event) => props.onBudgetChange(Number(event.target.value))}
                className="w-full accent-primary disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">
                The wallet also caps any single page at {formatFare(props.maxPerRequestCents)}.
              </p>
            </div>
            {props.running ? (
              <Button type="button" variant="outline" size="lg" onClick={props.onStop}>
                <Square />
                Stop
              </Button>
            ) : (
              <Button type="submit" size="lg" disabled={!canRun}>
                {props.disabled ? <Loader2 className="animate-spin" /> : <Play />}
                Run
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
