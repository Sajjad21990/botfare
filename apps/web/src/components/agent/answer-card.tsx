"use client";

import type { AnswerManifest } from "@botfare/contracts/receipts";
import { ExternalLink, Sparkles } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ResearchCitation } from "@/lib/server/research-events";
import { formatFare, formatUsd, shortPath } from "./format";
import { VerifySources } from "./verify-sources";

interface AnswerCardProps {
  answer: string;
  citations: ResearchCitation[];
  spentCents: number;
  budgetCents: number;
  /** The answer event's sources manifest, for "Verify sources" (optional until the agent sends it). */
  manifest?: AnswerManifest | null;
  /** Shows the citation's payment in the wire inspector. */
  onShowReceipt: (receiptId: string) => void;
}

/** The final answer with numbered citations, each tied to a receipt from this run. */
export function AnswerCard(props: AnswerCardProps) {
  const byNumber = new Map(props.citations.map((citation) => [citation.n, citation]));
  return (
    <Card className="ring-emerald-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" />
          Answer
        </CardTitle>
        <CardDescription>
          Researched for {formatUsd(props.spentCents)} of a {formatUsd(props.budgetCents)} budget,
          from {props.citations.length} paid {props.citations.length === 1 ? "source" : "sources"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 text-[0.95rem] leading-relaxed">
          {renderAnswer(props.answer, byNumber, props.onShowReceipt)}
        </div>
        {props.citations.length > 0 ? (
          <ol className="flex flex-col gap-3 border-t pt-4">
            {props.citations.map((citation) => (
              <li key={citation.n} id={`citation-${citation.n}`} className="flex gap-3 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
                  {citation.n}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                  >
                    <span className="truncate">{citation.title ?? shortPath(citation.url)}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                  <p className="text-muted-foreground">{citation.claim}</p>
                  <button
                    type="button"
                    onClick={() => props.onShowReceipt(citation.receiptId)}
                    className="flex w-fit flex-wrap items-center gap-x-2 rounded text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    title="Show this payment in the wire inspector"
                  >
                    <span className="font-mono">{citation.receiptId}</span>
                    <span>·</span>
                    <span className="tabular-nums">{formatFare(citation.amountCents)}</span>
                    <span>·</span>
                    <span>{citation.siteName}</span>
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <VerifySources citations={props.citations} manifest={props.manifest} />
      </CardContent>
    </Card>
  );
}

/** Paragraphs and simple lists, with **bold** and [n] citation markers. */
function renderAnswer(
  answer: string,
  citations: Map<number, ResearchCitation>,
  onShowReceipt: (receiptId: string) => void,
): ReactNode[] {
  const blocks = answer.trim().split(/\n\s*\n/);
  return blocks.map((block, index) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const isList = lines.length > 0 && lines.every((line) => /^([-*•]|\d+[.)])\s+/.test(line));
    const key = `block-${index}`;
    if (isList) {
      const ordered = /^\d/.test(lines[0] ?? "");
      const items = lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the answer is fixed once shown; lines never reorder
        <li key={`${key}-${i}`}>
          {inline(line.replace(/^([-*•]|\d+[.)])\s+/, ""), citations, onShowReceipt)}
        </li>
      ));
      return ordered ? (
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      );
    }
    return <p key={key}>{inline(lines.join(" "), citations, onShowReceipt)}</p>;
  });
}

function inline(
  text: string,
  citations: Map<number, ResearchCitation>,
  onShowReceipt: (receiptId: string) => void,
): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((part, index) => {
    const key = `part-${index}`;
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) return <strong key={key}>{bold[1]}</strong>;
    const marker = /^\[(\d+)\]$/.exec(part);
    const citation = marker ? citations.get(Number(marker[1])) : undefined;
    if (citation) {
      return (
        <sup key={key}>
          <button
            type="button"
            onClick={() => onShowReceipt(citation.receiptId)}
            title={`${citation.title ?? citation.url} · receipt ${citation.receiptId}`}
            className="rounded px-0.5 font-medium text-primary underline-offset-2 hover:underline"
          >
            [{citation.n}]
          </button>
        </sup>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}
