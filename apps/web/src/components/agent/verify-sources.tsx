"use client";

import {
  type AnswerManifest,
  type AnswerSource,
  checkAnswerSource,
  type SourceCheck,
} from "@botfare/contracts/receipts";
import { ExternalLink, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  fetchReceiptKeys,
  fetchReceiptStatements,
  VerifyFetchError,
  verifyHref,
} from "@/components/verify/verify-lib";
import type { ResearchCitation } from "@/lib/server/research-events";
import { cn } from "@/lib/utils";
import { shortPath } from "./format";

interface VerifySourcesProps {
  citations: ResearchCitation[];
  /** The answer's sources manifest (signed statements + digests of the bytes the agent read). */
  manifest?: AnswerManifest | null;
}

interface Row {
  n: number | null;
  title: string;
  check: SourceCheck;
}

type State =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; rows: Row[] }
  | { status: "error"; message: string };

/**
 * "This answer paid for its sources, and you can verify every one": checks each citation in the
 * browser against BotFare's public keys (paid, delivered, bytes match).
 */
export function VerifySources({ citations, manifest }: VerifySourcesProps) {
  const [state, setState] = useState<State>({ status: "idle" });

  async function run() {
    setState({ status: "checking" });
    try {
      const keys = await fetchReceiptKeys();
      const rows = await Promise.all(
        sourcesToCheck(citations, manifest).map(async ({ n, title, source, receiptId, url }) => {
          const resolved = await withLatestStatements(source, receiptId, url);
          const check: SourceCheck = resolved
            ? await checkAnswerSource(resolved, keys)
            : {
                receiptId,
                url,
                paid: { ok: false, message: "BotFare has no signed payment for this receipt" },
                delivered: { ok: false, message: "No delivery statement" },
                bytesMatch: { ok: false, message: "No digest of the read bytes" },
              };
          return { n, title, check };
        }),
      );
      setState({ status: "done", rows });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof VerifyFetchError ? err.message : "Verification failed. Try again.",
      });
    }
  }

  if (citations.length === 0 && !manifest?.sources.length) return null;

  const rows = state.status === "done" ? state.rows : [];
  const verified = rows.filter(isVerified).length;
  const paidOnly = rows.filter((row) => row.check.paid.ok && !isVerified(row)).length;

  return (
    <section aria-label="Verify sources" className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={run}
          disabled={state.status === "checking"}
        >
          {state.status === "checking" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          {state.status === "done" ? "Verify again" : "Verify sources"}
        </Button>
        {state.status === "done" ? (
          <p
            role="status"
            className={cn(
              "text-sm font-medium",
              verified === rows.length
                ? "text-emerald-800 dark:text-emerald-300"
                : "text-amber-800 dark:text-amber-300",
            )}
          >
            {verified} of {rows.length} {rows.length === 1 ? "source" : "sources"} verified
            {paidOnly > 0 ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {paidOnly} paid, not fully verified
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Checks, in your browser with BotFare&apos;s public key, that each source was paid,
            delivered and read as delivered.
          </p>
        )}
      </div>

      {state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}

      {state.status === "done" && !manifest ? (
        <p className="text-xs text-muted-foreground">
          This answer carries no sources manifest, so there is no digest of the bytes the agent read
          to compare; payments and deliveries were checked from BotFare&apos;s public statements.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.check.receiptId} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {row.n !== null ? (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
                    {row.n}
                  </span>
                ) : null}
                <span className="min-w-0 truncate font-medium">{row.title}</span>
                <Link
                  href={verifyHref(row.check.receiptId)}
                  target="_blank"
                  className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  <span className="font-mono">{row.check.receiptId}</span>
                  <ExternalLink aria-hidden className="size-3" />
                  <span className="sr-only">(open on the verify page)</span>
                </Link>
              </div>
              <ul className="mt-2 grid gap-2 sm:grid-cols-3">
                <CheckItem
                  label={row.check.refund?.refunded ? "Refunded" : "Paid"}
                  result={row.check.paid}
                />
                <CheckItem label="Delivered" result={row.check.delivered} />
                <CheckItem label="Bytes match" result={row.check.bytesMatch} />
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CheckItem({ label, result }: { label: string; result: { ok: boolean; message: string } }) {
  return (
    <li className="flex items-start gap-1.5">
      {result.ok ? (
        <ShieldCheck
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-400"
        />
      ) : (
        <ShieldX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <span className="min-w-0">
        <span className="font-medium">
          {result.ok ? "✓" : "✗"} {label}
        </span>
        <span className="block text-xs text-muted-foreground">{result.message}</span>
      </span>
    </li>
  );
}

function isVerified(row: Row): boolean {
  return row.check.paid.ok && row.check.delivered.ok && row.check.bytesMatch.ok;
}

interface Target {
  n: number | null;
  title: string;
  receiptId: string;
  url: string;
  source: AnswerSource | null;
}

/** Each citation with its manifest entry (if any), plus manifest sources the answer did not cite. */
function sourcesToCheck(
  citations: ResearchCitation[],
  manifest: AnswerManifest | null | undefined,
): Target[] {
  const byReceipt = new Map((manifest?.sources ?? []).map((source) => [source.receiptId, source]));
  const targets: Target[] = [...citations]
    .sort((a, b) => a.n - b.n)
    .map((citation) => ({
      n: citation.n,
      title: citation.title ?? shortPath(citation.url),
      receiptId: citation.receiptId,
      url: citation.url,
      source: byReceipt.get(citation.receiptId) ?? null,
    }));
  const cited = new Set(citations.map((citation) => citation.receiptId));
  for (const source of manifest?.sources ?? []) {
    if (cited.has(source.receiptId)) continue;
    targets.push({
      n: null,
      title: shortPath(source.url),
      receiptId: source.receiptId,
      url: source.url,
      source,
    });
  }
  return targets;
}

/**
 * Fills in what the manifest lacks from BotFare's public statements: the payment when there is no
 * manifest entry, the delivery when the publisher attested after the answer was written, and a
 * refund if the fare was returned since (so a refunded source no longer counts as paid).
 * Statements are signed, so where they come from does not matter; they are verified either way.
 */
async function withLatestStatements(
  source: AnswerSource | null,
  receiptId: string,
  url: string,
): Promise<AnswerSource | null> {
  let latest: Awaited<ReturnType<typeof fetchReceiptStatements>> = null;
  try {
    latest = await fetchReceiptStatements(receiptId);
  } catch {
    latest = null;
  }
  if (source) {
    return {
      ...source,
      delivery: source.delivery ?? latest?.delivery ?? null,
      refund: latest?.refund ?? source.refund ?? null,
    };
  }
  if (!latest?.payment) return null;
  return {
    url,
    receiptId,
    claim: "",
    payment: latest.payment,
    delivery: latest.delivery,
    readDigest: null,
    refund: latest.refund,
  };
}
