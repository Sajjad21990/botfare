"use client";

import type { BotFareStatement } from "@botfare/contracts/receipts";
import { cn } from "cn";
import { ArrowUpRightIcon, Check, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import landing from "@/components/landing/landing.module.css";
import { NewTabLink } from "@/components/landing/new-tab-link";
import { CopyButton } from "@/components/publisher/copy-button";
import { CopyChip } from "./copy-chip";
import { disclosureSummary } from "./disclosure";
import { isProven } from "./receipt-summary";
import {
  formatFareMicros,
  formatInstant,
  formatShareMicros,
  KIND_LABELS,
  KIND_SUMMARIES,
  percentOf,
  signalCopy,
} from "./statement-copy";
import { type CheckedStatement, decodePayloadJson } from "./verify-lib";

interface StatementCardProps {
  checked: CheckedStatement;
  /** The receipt the viewer asked about; a statement for another receipt is flagged. */
  receiptId: string | null;
  /** Every statement of the receipt verified. If not, a valid one is marked in ink, not green. */
  trusted?: boolean;
}

/**
 * One signed statement, folded: its kind and whether the signature holds, and inside, every field
 * it signs (long values as copyable chips) and the raw JWS.
 */
export function StatementCard({ checked, receiptId, trusted = true }: StatementCardProps) {
  const { result, decoded } = checked;
  const statement = result.ok ? result.statement : decoded;
  const otherReceipt = Boolean(receiptId && statement && statement.sub !== receiptId);
  const verified = isProven(checked, receiptId);
  const kind = statement?.kind ?? checked.slot;
  const kid = result.ok ? result.kid : (checked.header?.kid as string | undefined);
  const title = kind ? `${KIND_LABELS[kind]} statement` : "Statement";

  return (
    <details
      className={cn(
        "group rounded-xl border bg-card",
        verified ? "border-foreground/15" : "border-stamp/50",
      )}
    >
      <summary className={disclosureSummary}>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-semibold">{title}</span>
        {verified ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
              trusted ? "bg-success/10 text-success" : "bg-foreground/10 text-foreground",
            )}
          >
            <Check aria-hidden className="size-3.5" strokeWidth={3} />
            Signature valid
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-stamp/10 px-2 py-0.5 text-xs font-semibold text-stamp">
            <X aria-hidden className="size-3.5" strokeWidth={3} />
            Not valid
          </span>
        )}
        {statement ? (
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
            Signed{" "}
            <time dateTime={new Date(statement.iat * 1000).toISOString()}>
              {formatInstant(new Date(statement.iat * 1000).toISOString())}
            </time>
          </span>
        ) : null}
      </summary>

      <div className="flex flex-col gap-4 border-t border-foreground/10 px-4 pt-3 pb-4">
        {!result.ok ? (
          <p className="text-sm font-medium text-stamp">
            {result.message}.
            {result.error === "unknown_key"
              ? " BotFare never published this key, or another server signed it."
              : result.error === "bad_signature"
                ? " Someone changed it after BotFare signed it, or BotFare never signed it."
                : ""}{" "}
            {statement ? "The fields below are shown as written, not verified." : null}
          </p>
        ) : otherReceipt ? (
          <p className="text-sm font-medium text-stamp">
            The signature is valid, but this statement is about {statement?.sub}, not {receiptId}.
          </p>
        ) : kind ? (
          <p className="text-sm text-muted-foreground">{KIND_SUMMARIES[kind]}</p>
        ) : null}

        {statement ? (
          <Facts statement={statement} kid={kid ?? null} verified={verified} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Could not read this as a BotFare statement.
          </p>
        )}
        <RawJws checked={checked} />
      </div>
    </details>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <span className="mt-1 block text-xs text-muted-foreground">{children}</span>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

/** An http(s) URL, or null: only these become links. */
function webUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function Facts({
  statement,
  kid,
  verified,
}: {
  statement: BotFareStatement;
  kid: string | null;
  /** Only a verified statement's page URL is a link; an unverified one is shown as text. */
  verified: boolean;
}) {
  const pageUrl =
    verified && statement.kind === "payment" ? webUrl(statement.payment.resource) : null;
  const signal = statement.kind === "payment" ? signalCopy(statement.payment.signal) : null;
  const signedAt = new Date(statement.iat * 1000).toISOString();
  return (
    <dl className="flex flex-col divide-y divide-foreground/10 text-sm">
      <Fact label="Receipt">
        <CopyChip value={statement.sub} label="receipt ID" />
      </Fact>
      {statement.kind === "payment" ? (
        <>
          <Fact label="Price">{formatFareMicros(statement.payment.amountMicros)}</Fact>
          <Fact label="Split">
            The site {formatShareMicros(statement.payment.publisherMicros)} (
            {percentOf(statement.payment.publisherMicros, statement.payment.amountMicros)}%),
            BotFare fee {formatShareMicros(statement.payment.feeMicros)} (
            {percentOf(statement.payment.feeMicros, statement.payment.amountMicros)}%)
          </Fact>
          <Fact label="Paid to">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {statement.payment.siteOrigin ? (
                <span className="font-medium">{statement.payment.siteOrigin}</span>
              ) : null}
              <CopyChip value={statement.payment.payTo} label="site ID" />
            </span>
          </Fact>
          {statement.payment.resource ? (
            <Fact label="Page">
              <span className="flex min-w-0 items-center gap-2">
                <CopyChip value={statement.payment.resource} label="page URL" tail={18} />
                {pageUrl ? (
                  <NewTabLink
                    href={pageUrl}
                    icon={<ArrowUpRightIcon aria-hidden className="size-3.5" />}
                    className={`${landing.focusRing} inline-flex shrink-0 items-center gap-0.5 rounded-sm text-xs font-medium underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`}
                  >
                    Open
                  </NewTabLink>
                ) : null}
              </span>
            </Fact>
          ) : null}
          <Fact label="Payment type">
            x402 scheme <Mono>{statement.payment.scheme}</Mono> on{" "}
            <Mono>{statement.payment.network}</Mono>, amount <Mono>{statement.payment.amount}</Mono>{" "}
            in {statement.payment.asset === "USD" ? "US cents" : statement.payment.asset}
          </Fact>
          <Fact label="Paid by">
            <span className="flex flex-col items-start gap-1.5">
              <span className="flex max-w-full items-center gap-2">
                <span className="shrink-0">Agent key</span>
                <CopyChip value={statement.payment.payer} label="agent key ID" />
              </span>
              {statement.payment.payerThumbprint ? (
                <span className="flex max-w-full items-center gap-2 text-xs text-muted-foreground">
                  <span className="shrink-0">Thumbprint</span>
                  <CopyChip value={statement.payment.payerThumbprint} label="key thumbprint" />
                </span>
              ) : null}
            </span>
            {statement.payment.payerThumbprint ? (
              <Note>The agent&apos;s public key, hashed as in RFC 7638.</Note>
            ) : null}
          </Fact>
          {signal ? (
            <Fact label="Charge reason">
              {signal.label}
              <Note>{signal.detail}</Note>
            </Fact>
          ) : null}
          {statement.payment.offerDigest ? (
            <Fact label="Offer digest">
              <CopyChip value={statement.payment.offerDigest} label="offer digest" />
              <Note>Hash of the title and preview the agent saw before it paid.</Note>
            </Fact>
          ) : null}
          <Fact label="Settled at">
            <time dateTime={statement.payment.settledAt}>
              {formatInstant(statement.payment.settledAt)}
            </time>
          </Fact>
        </>
      ) : null}
      {statement.kind === "delivery" ? (
        <>
          <Fact label="Content-Digest">
            <CopyChip value={statement.delivery.contentDigest} label="content digest" />
            <Note>SHA-256 of the body the site sent, in RFC 9530 format.</Note>
          </Fact>
          <Fact label="Size">{statement.delivery.contentLength.toLocaleString("en-US")} bytes</Fact>
          <Fact label="Media type">
            <Mono>{statement.delivery.contentType || "(none)"}</Mono>
          </Fact>
          <Fact label="HTTP status">{statement.delivery.status}</Fact>
          <Fact label="Reported at">
            <time dateTime={statement.delivery.attestedAt}>
              {formatInstant(statement.delivery.attestedAt)}
            </time>
          </Fact>
        </>
      ) : null}
      {statement.kind === "refund" ? (
        <>
          <Fact label="Refunded">{formatFareMicros(statement.refund.refundedMicros)}</Fact>
          <Fact label="How">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {statement.refund.via === "dispute"
                ? "Fare Court dispute"
                : "Refund by the publisher"}
              {statement.refund.disputeId ? (
                <CopyChip value={statement.refund.disputeId} label="dispute ID" />
              ) : null}
            </span>
          </Fact>
          <Fact label="Refunded at">
            <time dateTime={statement.refund.refundedAt}>
              {formatInstant(statement.refund.refundedAt)}
            </time>
          </Fact>
        </>
      ) : null}
      <Fact label="Issued by">
        <CopyChip value={statement.iss} label="issuer" />
      </Fact>
      <Fact label="Signing key">
        {kid ? (
          <CopyChip value={kid} label="signing key ID" />
        ) : (
          <span className="text-muted-foreground">(no kid)</span>
        )}
      </Fact>
      <Fact label="Signed at">
        <time dateTime={signedAt}>{formatInstant(signedAt)}</time>
      </Fact>
    </dl>
  );
}

function RawJws({ checked }: { checked: CheckedStatement }) {
  const payload = decodePayloadJson(checked.token);
  return (
    <details className="group/raw rounded-lg border border-foreground/15 bg-background/60">
      <summary className={cn(disclosureSummary, "rounded-lg px-3 py-2 text-sm")}>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open/raw:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-medium">Raw JWS</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-foreground/10 px-3 pt-3 pb-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Protected header</p>
          <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
            {JSON.stringify(checked.header, null, 2)}
          </pre>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Claims</p>
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">Compact JWS</p>
            <CopyButton value={checked.token} label="Copy JWS" showLabel variant="outline" />
          </div>
          <p className="max-h-40 overflow-y-auto rounded-md bg-muted/60 p-2 font-mono text-xs break-all">
            {checked.token}
          </p>
        </div>
      </div>
    </details>
  );
}
