import { ReceiptText, ShieldCheck } from "lucide-react";
import { NewTabLink } from "@/components/app/external-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { verifyHref } from "@/components/verify/verify-href";
import { formatMoney, formatMoneyExact } from "./format";
import { LocalTime } from "./local-time";
import type { WalletReceipt } from "./types";

/** Recent paid requests across all the owner's agent keys. */
export function ReceiptsCard({ receipts, limit }: { receipts: WalletReceipt[]; limit: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Receipts</CardTitle>
        <CardDescription>
          Every page your AI agents paid for. A page is charged only after the website delivers it,
          and every receipt is signed so anyone can check it.
          {receipts.length >= limit ? ` Showing the latest ${limit}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {receipts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <ReceiptText className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No paid pages yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                When one of your AI agents pays for a page, its receipt shows up here with the site,
                the page and the price.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Page</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Receipt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.map((receipt) => (
                <TableRow key={receipt.id}>
                  <TableCell className="text-muted-foreground">
                    <LocalTime iso={receipt.createdAt} />
                  </TableCell>
                  <TableCell className="font-medium">{receipt.siteName}</TableCell>
                  <TableCell>
                    <span
                      className="block max-w-56 truncate font-mono text-xs"
                      title={receipt.path}
                    >
                      {receipt.path}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{receipt.agentKeyName}</TableCell>
                  <TableCell
                    className={
                      receipt.status === "refunded"
                        ? "text-right tabular-nums text-muted-foreground line-through"
                        : "text-right tabular-nums"
                    }
                    title={formatMoneyExact(receipt.amountMicros)}
                  >
                    {formatMoney(receipt.amountMicros)}
                  </TableCell>
                  <TableCell>
                    {receipt.status === "refunded" ? (
                      <Badge variant="secondary">Refunded</Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-success/40 font-semibold text-success"
                      >
                        Paid
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{receipt.id}</span>
                      <NewTabLink
                        href={verifyHref(receipt.id)}
                        className="inline-flex items-center gap-1 rounded font-medium text-foreground underline-offset-4 hover:underline"
                        title="Check BotFare's signed statements for this receipt"
                      >
                        <ShieldCheck aria-hidden className="size-3.5" />
                        Verify
                        <span className="sr-only"> receipt {receipt.id}</span>
                      </NewTabLink>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
