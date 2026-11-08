"use client";

import { ArrowDown, Cable } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { centsFromAmount, formatFare, shortPath } from "./format";
import type { TimelineEntry, WireTrace } from "./run-state";

type Inspectable = Extract<TimelineEntry, { kind: "offer" | "payment" | "refusal" }>;

/**
 * The x402 handshake for the selected entry, decoded:
 * PAYMENT-REQUIRED (the 402) → PAYMENT-SIGNATURE (the agent's signed JWS) → PAYMENT-RESPONSE.
 */
export function WireInspector({
  entry,
  trace,
}: {
  entry: Inspectable | null;
  trace: WireTrace | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cable className="size-4" />
          Wire inspector
        </CardTitle>
        <CardDescription>
          {entry ? (
            <span className="font-mono text-xs">{shortPath(entry.url)}</span>
          ) : (
            "The x402 headers behind a payment, decoded."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!entry ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            When the agent reads an offer or pays a fare, select it in the timeline to see
            PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <RequiredStep trace={trace} />
            <Arrow />
            <SignatureStep trace={trace} entry={entry} />
            <Arrow />
            <ResponseStep trace={trace} entry={entry} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Arrow() {
  return (
    <div className="flex justify-center text-muted-foreground" aria-hidden>
      <ArrowDown className="size-4" />
    </div>
  );
}

function Step({
  label,
  status,
  tone,
  children,
}: {
  label: string;
  status: string;
  tone: "done" | "missing" | "refused";
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        tone === "missing" && "border-dashed",
        tone === "refused" && "border-destructive/40 border-dashed",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold">{label}</span>
        <Badge
          variant={tone === "refused" ? "destructive" : tone === "done" ? "outline" : "secondary"}
        >
          {status}
        </Badge>
      </div>
      {children}
    </section>
  );
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd
            className="min-w-0 truncate font-mono"
            title={typeof value === "string" ? value : undefined}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Raw({ header, length, decoded }: { header: string; length: number; decoded: unknown }) {
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        Decoded JSON ({length} base64 chars on the wire)
      </summary>
      <p className="mt-2 font-mono break-all text-muted-foreground">{header}</p>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(decoded, null, 2)}
      </pre>
    </details>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return value === undefined || value === null ? "—" : String(value);
}

function RequiredStep({ trace }: { trace: WireTrace | null }) {
  const required = trace?.required;
  if (!required) {
    return (
      <Step label="PAYMENT-REQUIRED" status="No 402" tone="missing">
        <p className="text-xs text-muted-foreground">The page did not ask for payment.</p>
      </Step>
    );
  }
  const decoded = record(required.decoded);
  const accepts = Array.isArray(decoded.accepts) ? decoded.accepts.map(record) : [];
  const accept = accepts.find((a) => a.scheme === "prepaid") ?? accepts[0] ?? {};
  const cents = centsFromAmount(accept.amount);
  const resource = record(decoded.resource);
  return (
    <Step label="PAYMENT-REQUIRED" status="402" tone="done">
      <Fields
        rows={[
          [
            "price",
            cents !== null
              ? `${formatFare(cents)} (amount "${text(accept.amount)}")`
              : text(accept.amount),
          ],
          ["scheme", `${text(accept.scheme)} on ${text(accept.network)}`],
          ["asset", text(accept.asset)],
          ["payTo", text(accept.payTo)],
          ["resource", text(resource.url)],
          ["x402", `v${text(decoded.x402Version)}`],
        ]}
      />
      <Raw header={required.header} length={required.headerLength} decoded={required.decoded} />
    </Step>
  );
}

function SignatureStep({ trace, entry }: { trace: WireTrace | null; entry: Inspectable }) {
  const signature = trace?.signature;
  if (!signature) {
    const refused = entry.kind === "refusal";
    return (
      <Step
        label="PAYMENT-SIGNATURE"
        status={refused ? "Not signed" : entry.kind === "offer" ? "Not sent" : "—"}
        tone={refused ? "refused" : "missing"}
      >
        <p className="text-xs text-muted-foreground">
          {refused
            ? entry.by === "spend-limit"
              ? "The SDK refused before signing: the price is over the agent's per-request cap."
              : entry.message
            : entry.kind === "offer"
              ? "Reading an offer is free: the agent sent no payment."
              : "No signature recorded."}
        </p>
      </Step>
    );
  }
  const jws = signature.jwsHeader ?? {};
  const claims = signature.claims;
  const cents = centsFromAmount(claims.amount);
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  return (
    <Step label="PAYMENT-SIGNATURE" status="Ed25519 JWS" tone="done">
      <Fields
        rows={[
          ["alg / typ", `${text(jws.alg)} / ${text(jws.typ)}`],
          ["kid", text(jws.kid)],
          ["amount", cents !== null ? formatFare(cents) : text(claims.amount)],
          ["payTo", text(claims.payTo)],
          ["nonce", text(claims.nonce)],
          ["expires", iat !== null && exp !== null ? `${exp - iat}s after signing` : "—"],
        ]}
      />
      <Raw
        header={signature.header}
        length={signature.headerLength}
        decoded={{ jwsHeader: jws, claims, payload: signature.decoded }}
      />
    </Step>
  );
}

function ResponseStep({ trace, entry }: { trace: WireTrace | null; entry: Inspectable }) {
  const response = trace?.response;
  if (!response) {
    return (
      <Step
        label="PAYMENT-RESPONSE"
        status={entry.kind === "refusal" ? "No charge" : "—"}
        tone={entry.kind === "refusal" ? "refused" : "missing"}
      >
        <p className="text-xs text-muted-foreground">
          {entry.kind === "refusal" ? "Nothing was settled." : "No settlement for this request."}
        </p>
      </Step>
    );
  }
  const decoded = record(response.decoded);
  const success = decoded.success === true;
  return (
    <Step
      label="PAYMENT-RESPONSE"
      status={success ? "Settled" : "Failed"}
      tone={success ? "done" : "refused"}
    >
      <Fields
        rows={[
          ["receipt", text(decoded.transaction)],
          ["network", text(decoded.network)],
          ["payer", text(decoded.payer)],
          ...(success ? [] : ([["reason", text(decoded.errorReason)]] as [string, ReactNode][])),
        ]}
      />
      <Raw header={response.header} length={response.headerLength} decoded={response.decoded} />
    </Step>
  );
}
