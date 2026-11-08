import { Scale } from "lucide-react";
import Link from "next/link";
import {
  decidedByLabel,
  formatFare,
  reasonLabel,
  statusMeta,
} from "@/components/publisher/disputes-format";
import type { DisputeView } from "@/components/publisher/disputes-types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { verifyHref } from "@/components/verify/verify-href";
import { LocalTime } from "./local-time";

/** Fare Court disputes filed by the owner's agents, with the outcome and the AI's reasoning. */
export function DisputesCard({ disputes, limit }: { disputes: DisputeView[]; limit: number }) {
  const refundedCents = disputes.reduce((sum, d) => sum + d.refundedCents, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Disputes</CardTitle>
        <CardDescription>
          When a paid page is not what its offer promised, your agent can dispute it within 24
          hours. Fare Court's AI refunds clear cases in seconds; the publisher decides the rest.
          {disputes.length > 0 && refundedCents > 0
            ? ` ${formatFare(refundedCents)} refunded so far.`
            : ""}
          {disputes.length >= limit ? ` Showing the latest ${limit}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {disputes.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <Scale className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No disputes</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Your agents have not disputed any purchase. The SDK's dispute(), the MCP tool
                dispute_purchase and the research agent can all file one.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {disputes.map((dispute) => {
              const status = statusMeta(dispute.status, "owner");
              const by = decidedByLabel(dispute, "owner");
              return (
                <li key={dispute.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className="min-w-0 max-w-full truncate font-mono text-sm"
                      title={dispute.url ?? dispute.path}
                    >
                      {dispute.path}
                    </span>
                    <span className="text-sm text-muted-foreground">{dispute.siteName}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span
                        className={
                          dispute.status === "refunded"
                            ? "text-sm tabular-nums text-muted-foreground line-through"
                            : "text-sm tabular-nums"
                        }
                      >
                        {formatFare(dispute.amountCents)}
                      </span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="text-foreground">{reasonLabel(dispute.reason)}</span> ·{" "}
                    {dispute.agentKeyName} · <LocalTime iso={dispute.createdAt} />
                    {by ? ` · decided ${by}` : ""} ·{" "}
                    <Link
                      href={verifyHref(dispute.receiptId)}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      Verify receipt
                    </Link>
                  </p>
                  <p className="text-sm">{dispute.verdict?.rationale ?? dispute.message}</p>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
