import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatFare, formatUsd } from "./format";
import type { RunView } from "./run-state";

const STATUS_LABEL: Record<RunView["status"], string> = {
  idle: "Ready",
  starting: "Starting",
  running: "Running",
  finished: "Finished",
  stopped: "Stopped",
  failed: "Failed",
};

/** Live spend against the budget, receipts and tool calls. */
export function CostMeter({ view, receipts }: { view: RunView; receipts: number }) {
  const percent =
    view.budgetCents > 0 ? Math.min(100, (view.spentCents / view.budgetCents) * 100) : 0;
  const remaining = Math.max(0, view.budgetCents - view.spentCents);
  const busy = view.status === "running" || view.status === "starting";
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums" aria-live="polite">
              {formatUsd(view.spentCents)}
            </span>
            <span className="text-sm text-muted-foreground">
              of {formatUsd(view.budgetCents)} spent
            </span>
          </div>
          <Badge
            variant={view.status === "failed" ? "destructive" : busy ? "default" : "secondary"}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {STATUS_LABEL[view.status]}
          </Badge>
        </div>
        <Progress value={percent} aria-label="Budget spent" />
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Stat label="Left" value={formatFare(remaining)} />
          <Stat label="Receipts" value={String(receipts)} />
          <Stat label="Tool calls" value={`${view.toolCalls}/${view.maxToolCalls}`} />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
