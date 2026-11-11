"use client";

import { contentDigestSha256 } from "@botfare/contracts/fare";
import type { BotFareStatement, DeliveryStatement } from "@botfare/contracts/receipts";
import { ChevronRight, ShieldCheck, ShieldX } from "lucide-react";
import { type ReactNode, useState } from "react";
import { NewTabLink } from "@/components/app/external-link";
import { CopyButton } from "@/components/publisher/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  formatFareMicros,
  formatInstant,
  formatMoneyMicros,
  headline,
  KIND_LABELS,
  KIND_SUMMARIES,
  percentOf,
  signalCopy,
  statementTime,
} from "./statement-copy";
import { type CheckedStatement, decodePayloadJson } from "./verify-lib";

interface StatementCardProps {
  checked: CheckedStatement;
  /** The receipt the viewer asked about; a statement for another receipt is flagged. */
  receiptId: string | null;
}

/** One signed statement: whether it verifies, what it says, and the raw JWS. */
export function StatementCard({ checked, receiptId }: StatementCardProps) {
  const { result, decoded } = checked;
  const statement = result.ok ? result.statement : decoded;
  const otherReceipt = Boolean(receiptId && statement && statement.sub !== receiptId);
  const verified = result.ok && !otherReceipt;
  const kind = statement?.kind ?? checked.slot;
  const kid = result.ok ? result.kid : (checked.header?.kid as string | undefined);

  return (
    <Card
      className={cn(
        verified ? "ring-emerald-600/30 dark:ring-emerald-400/30" : "ring-destructive/40",
      )}
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {verified ? (
            <ShieldCheck aria-hidden className="size-5 text-emerald-700 dark:text-emerald-400" />
          ) : (
            <ShieldX aria-hidden className="size-5 text-destructive" />
          )}
          <h3 className="text-base font-semibold tracking-tight">
            {kind ? `${KIND_LABELS[kind]} statement` : "Statement"}
          </h3>
          {verified ? (
            <Badge className="bg-emerald-600/10 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300">
              ✓ Signature valid
            </Badge>
          ) : (
            <Badge variant="destructive">✗ Not verified</Badge>
          )}
        </div>
        {!result.ok ? (
          <p className="text-sm text-destructive">
            {result.message}.
            {result.error === "unknown_key"
              ? " BotFare never published this key, or another server signed it."
              : result.error === "bad_signature"
                ? " Someone changed it after BotFare signed it, or BotFare never signed it."
                : ""}
          </p>
        ) : otherReceipt ? (
          <p className="text-sm text-destructive">
            The signature is valid, but this statement is about {statement?.sub}, not {receiptId}.
          </p>
        ) : kind ? (
          <p className="text-sm text-muted-foreground">{KIND_SUMMARIES[kind]}</p>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {statement ? (
          <>
            <div>
              <p className="text-lg font-semibold tracking-tight text-balance">
                {headline(statement)}
              </p>
              <p className="text-sm text-muted-foreground">
                <time dateTime={statementTime(statement)}>
                  {formatInstant(statementTime(statement))}
                </time>
                {!result.ok ? " · shown as written, not verified" : null}
              </p>
            </div>
            <Facts statement={statement} kid={kid ?? null} verified={verified} />
            {verified && statement.kind === "delivery" ? (
              <CheckYourCopy statement={statement} />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Could not read this as a BotFare statement.
          </p>
        )}
        <RawJws checked={checked} />
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
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
  return (
    <dl className="flex flex-col gap-2 border-t pt-4 text-sm">
      <Fact label="Receipt">
        <Mono>{statement.sub}</Mono>
      </Fact>
      {statement.kind === "payment" ? (
        <>
          <Fact label="Price">{formatFareMicros(statement.payment.amountMicros)}</Fact>
          <Fact label="Split">
            Publisher {formatMoneyMicros(statement.payment.publisherMicros)} (
            {percentOf(statement.payment.publisherMicros, statement.payment.amountMicros)}%) ·
            BotFare fee {formatMoneyMicros(statement.payment.feeMicros)} (
            {percentOf(statement.payment.feeMicros, statement.payment.amountMicros)}%)
          </Fact>
          <Fact label="Paid to">
            {statement.payment.siteOrigin ?? "Site"} <Mono>({statement.payment.payTo})</Mono>
          </Fact>
          {statement.payment.resource ? (
            <Fact label="Page">
              {pageUrl ? (
                <NewTabLink
                  href={pageUrl}
                  icon
                  className="inline-flex max-w-full items-center gap-0.5 rounded-sm font-mono text-xs underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {statement.payment.resource}
                </NewTabLink>
              ) : (
                <Mono>{statement.payment.resource}</Mono>
              )}
            </Fact>
          ) : null}
          <Fact label="Payment type">
            x402 scheme <Mono>{statement.payment.scheme}</Mono> on{" "}
            <Mono>{statement.payment.network}</Mono>, amount <Mono>{statement.payment.amount}</Mono>{" "}
            in {statement.payment.asset === "USD" ? "US cents" : statement.payment.asset}
          </Fact>
          <Fact label="Paid by">
            Agent key <Mono>{statement.payment.payer}</Mono>
            {statement.payment.payerThumbprint ? (
              <span className="block text-xs text-muted-foreground">
                Key thumbprint (RFC 7638) <Mono>{statement.payment.payerThumbprint}</Mono>
              </span>
            ) : null}
          </Fact>
          {signal ? (
            <Fact label="Charge reason">
              {signal.label}
              <span className="block text-xs text-muted-foreground">{signal.detail}</span>
            </Fact>
          ) : null}
          {statement.payment.offerDigest ? (
            <Fact label="Offer digest">
              <Mono>{statement.payment.offerDigest}</Mono>
              <span className="block text-xs text-muted-foreground">
                Hash of the title and preview the agent saw before it paid.
              </span>
            </Fact>
          ) : null}
        </>
      ) : null}
      {statement.kind === "delivery" ? (
        <>
          <Fact label="Content-Digest">
            <Mono>{statement.delivery.contentDigest}</Mono>
            <span className="block text-xs text-muted-foreground">
              SHA-256 of the body the site sent, in RFC 9530 format.
            </span>
          </Fact>
          <Fact label="Size">{statement.delivery.contentLength.toLocaleString("en-US")} bytes</Fact>
          <Fact label="Media type">
            <Mono>{statement.delivery.contentType || "(none)"}</Mono>
          </Fact>
          <Fact label="HTTP status">{statement.delivery.status}</Fact>
        </>
      ) : null}
      {statement.kind === "refund" ? (
        <>
          <Fact label="Refunded">{formatFareMicros(statement.refund.refundedMicros)}</Fact>
          <Fact label="How">
            {statement.refund.via === "dispute" ? "Fare Court dispute" : "Refund by the publisher"}
            {statement.refund.disputeId ? (
              <>
                {" "}
                <Mono>({statement.refund.disputeId})</Mono>
              </>
            ) : null}
          </Fact>
        </>
      ) : null}
      <Fact label="Issued by">
        <Mono>{statement.iss}</Mono>
      </Fact>
      <Fact label="Signing key">
        {kid ? <Mono>{kid}</Mono> : <span className="text-muted-foreground">(no kid)</span>}
      </Fact>
      <Fact label="Signed at">
        <time dateTime={new Date(statement.iat * 1000).toISOString()}>
          {formatInstant(new Date(statement.iat * 1000).toISOString())}
        </time>
      </Fact>
    </dl>
  );
}

/** Lets the viewer hash their own copy of the content and compare it with the signed digest. */
function CheckYourCopy({ statement }: { statement: DeliveryStatement }) {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<{ digest: string; source: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function hash(body: Uint8Array | string, source: string) {
    setBusy(true);
    try {
      setOutcome({ digest: await contentDigestSha256(body), source });
    } finally {
      setBusy(false);
    }
  }

  const matches = outcome ? outcome.digest === statement.delivery.contentDigest : null;

  return (
    <details className="group rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        Check your copy
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-muted-foreground">
          Pick the file you received or paste its exact text. Your browser hashes it and uploads
          nothing.
        </p>
        <input
          type="file"
          aria-label="File to hash"
          className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-2.5 file:py-1 file:text-sm file:font-medium"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await hash(new Uint8Array(await file.arrayBuffer()), file.name);
          }}
        />
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Or paste the exact body here"
          aria-label="Content to hash"
          className="max-h-40 font-mono text-xs"
        />
        <div>
          <button
            type="button"
            disabled={!text || busy}
            onClick={() => hash(text, "The pasted text")}
            className="rounded-md border bg-background px-2.5 py-1 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            Hash the pasted text
          </button>
        </div>
        {outcome ? (
          <p
            role="status"
            className={matches ? "text-emerald-800 dark:text-emerald-300" : "text-destructive"}
          >
            {matches
              ? `✓ ${outcome.source} matches the signed digest byte for byte.`
              : `✗ ${outcome.source} hashes to ${outcome.digest}, not the signed digest.`}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function RawJws({ checked }: { checked: CheckedStatement }) {
  const payload = decodePayloadJson(checked.token);
  return (
    <details className="group rounded-lg border px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        Raw JWS
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Protected header</p>
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
            {JSON.stringify(checked.header, null, 2)}
          </pre>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Claims</p>
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">Compact JWS</p>
            <CopyButton value={checked.token} label="Copy the JWS" />
          </div>
          <p className="max-h-40 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-xs break-all">
            {checked.token}
          </p>
        </div>
      </div>
    </details>
  );
}
