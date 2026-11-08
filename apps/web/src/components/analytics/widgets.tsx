"use client";

import type { AgWidgetDataResponse, AgWidgetField, AgWidgetParams } from "ag-studio";
import { ArrowUpRight, Radio, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { timeAgo, usd, useLiveState, useNow } from "./live-store";
import type { EarningsWidgetState, LiveReceiptsWidgetState } from "./registry";
import { field } from "./report";
import type { ReceiptRow } from "./types";

/**
 * BotFare's custom AG Studio widgets. Both read the receipts table through `widgetApi.getData`,
 * so page filters and cross filters apply (click an agent's bar and the ticker shows only that
 * agent), and both stay current as the poller applies live transactions to the engine.
 * Colours come from the Studio theme's CSS variables so light and dark modes both work.
 */

const text = "text-[color:var(--ag-text-color)]";
const subtle = "text-[color:var(--ag-subtle-text-color)]";
const border = "border-[color:var(--ag-border-color)]";
const up = "text-[color:var(--ag-value-change-up-color)]";

/** Looks up schema fields of the receipts table by column name. */
function schemaFields(
  params: AgWidgetParams<never> | AgWidgetParams<LiveReceiptsWidgetState | EarningsWidgetState>,
  names: (keyof ReceiptRow)[],
): AgWidgetField[] | null {
  const all = params.widgetApi.getSchema().flatMap((table) => table.fields);
  const found = names.map((name) =>
    all.find((candidate) => candidate.fieldId === field(name) && !candidate.aggregation),
  );
  return found.every(Boolean) ? (found as AgWidgetField[]) : null;
}

function WidgetHeader({
  icon,
  title,
  aside,
}: {
  icon: React.ReactNode;
  title: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 pb-2">
      <span className={`shrink-0 ${subtle}`}>{icon}</span>
      <span className={`truncate text-sm font-medium ${text}`}>{title}</span>
      <span className={`ml-auto shrink-0 text-xs whitespace-nowrap ${subtle}`}>{aside}</span>
    </div>
  );
}

interface TickerRow {
  id: string;
  createdAt: number;
  path: string;
  agent: string;
  amount: string;
  refunded: boolean;
  /** Why the request was asked to pay, e.g. "Agent header". */
  signal: string;
}

/** "Live paid requests": the newest receipts, sliding in as agents pay. */
export function LiveReceiptsWidget(params: AgWidgetParams<LiveReceiptsWidgetState>) {
  const [rows, setRows] = useState<TickerRow[] | null>(null);
  const live = useLiveState();
  const now = useNow();

  useEffect(() => {
    const { widgetApi } = params;
    const fields = schemaFields(params, [
      "receiptId",
      "createdAt",
      "path",
      "agentName",
      "amountUsd",
      "status",
      "detectionSignal",
    ]);
    if (!fields) {
      widgetApi.setDisplayState("noData");
      return;
    }
    const [idF, createdF, pathF, agentF, amountF, statusF, signalF] = fields as [
      AgWidgetField,
      AgWidgetField,
      AgWidgetField,
      AgWidgetField,
      AgWidgetField,
      AgWidgetField,
      AgWidgetField,
    ];
    let active = true;
    const apply = (response: AgWidgetDataResponse) => {
      if (!active || response.replaced) return;
      const next = response.results.rows.map((row) => ({
        id: String(row[idF.key]),
        createdAt: new Date(row[createdF.key]).getTime(),
        path: String(row[pathF.key] ?? ""),
        agent: String(row[agentF.key] ?? ""),
        amount: widgetApi.formatFieldValue(amountF, row[amountF.key]),
        refunded: row[statusF.key] === "refunded",
        signal: String(row[signalF.key] ?? ""),
      }));
      setRows(next);
      widgetApi.setDisplayState(next.length > 0 ? "displayed" : "noData");
    };
    widgetApi
      .getData(
        { fields, sort: [{ field: createdF, direction: "desc" }], limit: { count: 8 } },
        { queryId: "ticker", onDataUpdated: apply },
      )
      .then(apply)
      .catch(() => widgetApi.setDisplayState("noData"));
    return () => {
      active = false;
    };
  }, [params]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <WidgetHeader
        icon={<Radio className="size-4" />}
        title="Live paid requests"
        aside={
          <span className="inline-flex items-center gap-1.5">
            <span className="relative flex size-2">
              {live.online && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              )}
              <span
                className={`relative inline-flex size-2 rounded-full ${live.online ? "bg-emerald-500" : "bg-amber-500"}`}
              />
            </span>
            {live.online ? `Live · ${timeAgo(live.lastSyncAt, now)}` : "Reconnecting"}
          </span>
        }
      />
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {(rows ?? []).map((row) => {
          const fresh = live.freshIds.includes(row.id);
          return (
            <li
              key={row.id}
              className={`flex items-center gap-3 border-t ${border} px-1 py-2 first:border-t-0 ${
                fresh ? "animate-in fade-in slide-in-from-top-2 duration-500" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className={`truncate font-mono text-xs ${text}`} title={row.path}>
                  {row.path}
                </div>
                <div className={`flex min-w-0 items-center gap-1.5 text-xs ${subtle}`}>
                  <span className="min-w-0 truncate">{row.agent}</span>
                  <span className="shrink-0 whitespace-nowrap">
                    · {timeAgo(row.createdAt, now)}
                  </span>
                  {row.signal && (
                    <span
                      className={`shrink-0 rounded border ${border} px-1 py-px text-[10px] leading-none whitespace-nowrap`}
                      title="Why BotFare asked this request to pay"
                    >
                      {row.signal}
                    </span>
                  )}
                </div>
              </div>
              <span
                className={`shrink-0 text-sm font-medium tabular-nums ${
                  row.refunded ? `${subtle} line-through` : fresh ? up : text
                }`}
              >
                {row.amount}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Earnings & payout": the withdrawable balance, what the current view earned, and the way out. */
export function EarningsWidget(params: AgWidgetParams<EarningsWidgetState>) {
  const live = useLiveState();
  const now = useNow();
  const [view, setView] = useState<{ earned: number; fees: number; count: number } | null>(null);

  useEffect(() => {
    const { widgetApi } = params;
    const fields = schemaFields(params, ["receiptId", "earningsUsd", "feeUsd"]);
    if (!fields) return;
    const [idF, earnF, feeF] = fields as [AgWidgetField, AgWidgetField, AgWidgetField];
    let active = true;
    const apply = (response: AgWidgetDataResponse) => {
      if (!active || response.replaced) return;
      let earned = 0;
      let fees = 0;
      for (const row of response.results.rows) {
        earned += Number(row[earnF.key]) || 0;
        fees += Number(row[feeF.key]) || 0;
      }
      setView({ earned, fees, count: response.results.rows.length });
    };
    widgetApi
      .getData(
        { fields: [idF, earnF, feeF], limit: { count: 5000 } },
        { queryId: "earnings", onDataUpdated: apply },
      )
      .then(apply)
      .catch(() => setView(null));
    return () => {
      active = false;
    };
  }, [params]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <WidgetHeader
        icon={<Wallet className="size-4" />}
        title="Earnings & payout"
        aside={timeAgo(live.lastSyncAt, now)}
      />
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-1">
        <span className={`text-xs ${subtle}`}>Ready to withdraw</span>
        <span className={`truncate text-3xl font-semibold tracking-tight tabular-nums ${text}`}>
          {usd(live.earningsUsd, 4)}
        </span>
        <span className={`line-clamp-1 text-xs ${subtle}`}>
          Paid to your PayPal account via Payouts
        </span>
      </div>
      <dl className={`grid grid-cols-2 gap-2 border-t ${border} px-1 py-2 text-xs`}>
        <div className="min-w-0">
          <dt className={`truncate ${subtle}`}>Earned in view</dt>
          <dd className={`mt-0.5 truncate text-sm font-medium tabular-nums ${text}`}>
            {view ? usd(view.earned, 4) : "–"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={`truncate ${subtle}`}>Fees (5%)</dt>
          <dd className={`mt-0.5 truncate text-sm font-medium tabular-nums ${text}`}>
            {view ? usd(view.fees, 4) : "–"}
          </dd>
        </div>
      </dl>
      <a
        href="/publisher"
        className="mx-1 inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--ag-accent-color)] px-3 text-sm font-medium whitespace-nowrap text-[color:var(--ag-background-color)] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ag-accent-color)]"
      >
        Withdraw with PayPal
        <ArrowUpRight className="size-4" />
      </a>
    </div>
  );
}
