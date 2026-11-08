import type {
  AgDataSourcesDefinition,
  AgFieldDefinition,
  AgReportState,
  AgWidgetFieldReference,
} from "ag-studio";
import { type BotFareRegistry, EARNINGS_PAYOUT, LIVE_RECEIPTS } from "./registry";
import type { ReceiptRow } from "./types";

/** The single table the dashboard reads. */
export const RECEIPTS_TABLE = "receipts";

/** A field of the receipts table as widgets and filters reference it. */
export const field = (id: keyof ReceiptRow): string => `${RECEIPTS_TABLE}.${id}`;

/** A row as the AG Studio engine holds it: a real timestamp and the day in the viewer's time zone. */
export type StudioReceiptRow = Omit<ReceiptRow, "createdAt"> & { createdAt: Date };

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toStudioRow(row: ReceiptRow): StudioReceiptRow {
  const createdAt = new Date(row.createdAt);
  return { ...row, createdAt, day: localDay(createdAt) };
}

const USD = { format: "$#,##0.00##" };

const fields: AgFieldDefinition[] = [
  {
    id: "receiptId",
    name: "Receipt",
    format: "textFormat",
    description: "Receipt ID (also the x402 settlement transaction ID).",
  },
  {
    id: "createdAt",
    name: "Paid at",
    format: "dateTimeFormat",
    formatOptions: { format: "dd mmm, hh:mm:ss" },
    description: "When the agent's payment settled.",
  },
  {
    id: "day",
    name: "Day",
    format: "dateFormat",
    formatOptions: { format: "dd mmm" },
    description: "Calendar day of the payment, in the viewer's time zone.",
  },
  { id: "siteName", name: "Site", format: "textFormat", description: "The publisher's site." },
  {
    id: "path",
    name: "Page",
    format: "textFormat",
    description: "Path of the paid page or API endpoint, e.g. /articles/grinders.",
  },
  {
    id: "agentKeyId",
    name: "Agent key",
    format: "textFormat",
    description: "ID of the agent key that paid. Count distinct values for unique agents.",
  },
  {
    id: "agentName",
    name: "Agent",
    format: "textFormat",
    description: "Name the agent's owner gave the paying key.",
  },
  {
    id: "amountUsd",
    name: "Price",
    format: "currencyFormat",
    formatOptions: USD,
    description: "What the agent paid for the request, in USD.",
  },
  {
    id: "feeUsd",
    name: "BotFare fee",
    format: "currencyFormat",
    formatOptions: { format: "$#,##0.0000" },
    description: "BotFare's 5% platform fee on the payment, in USD.",
  },
  {
    id: "earningsUsd",
    name: "Earnings",
    format: "currencyFormat",
    formatOptions: USD,
    description:
      "What the publisher keeps in USD: price minus the 5% fee, or 0 if the receipt was refunded. This is revenue.",
  },
  {
    id: "status",
    name: "Status",
    format: "textFormat",
    description: "settled, or refunded by the publisher.",
  },
];

/** The receipts as an AG Studio data source that accepts live transactions keyed by receipt ID. */
export function receiptsDataSource(rows: ReceiptRow[]): AgDataSourcesDefinition<BotFareRegistry> {
  return {
    description:
      "Paid requests from AI agents to this publisher's sites, settled over x402 on BotFare (pay-per-request on PayPal). One row per receipt. Revenue means the sum of earningsUsd.",
    sources: [
      {
        id: RECEIPTS_TABLE,
        name: "Paid requests",
        description: "One row per paid request (receipt), newest first.",
        primaryKeyField: "receiptId",
        transactions: "all",
        data: rows.map(toStudioRow),
        fields,
      },
    ],
  };
}

const sum = (id: keyof ReceiptRow): AgWidgetFieldReference => ({
  id: field(id),
  aggregation: "sum",
});
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});

/**
 * The dashboard a publisher opens to: KPI tiles, revenue over time, by page and by agent, the
 * live ticker, earnings and payout, and every receipt. 24 columns; rows are 16px.
 */
export const initialReport: AgReportState<BotFareRegistry> = {
  selectedPageId: "overview",
  panels: {
    filters: { collapsed: true },
    data: { collapsed: true },
    edit: { collapsed: true },
    ai: { collapsed: false },
  },
  pages: [
    {
      id: "overview",
      widgets: {
        revenueToday: {
          type: "value",
          dataMapping: { value: [sum("earningsUsd")] },
          format: title("Revenue today"),
        },
        paidRequests: {
          type: "value",
          dataMapping: {
            value: [{ id: field("receiptId"), aggregation: "count" }],
            sparklineX: [{ id: field("day") }],
          },
          format: title("Paid requests"),
        },
        uniqueAgents: {
          type: "value",
          dataMapping: { value: [{ id: field("agentKeyId"), aggregation: "countd" }] },
          format: title("Unique agents"),
        },
        averagePrice: {
          type: "value",
          dataMapping: { value: [{ id: field("amountUsd"), aggregation: "avg" }] },
          format: title("Average price"),
        },
        revenueByDay: {
          type: "column-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: field("day") }],
            valueKey: [sum("earningsUsd")],
            tooltipKey: [],
          },
          format: title("Revenue by day", "Earnings after BotFare's 5% fee"),
        },
        earnings: { type: EARNINGS_PAYOUT, dataMapping: {} },
        revenueByPage: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: field("path") }],
            valueKey: [sum("earningsUsd")],
            tooltipKey: [],
          },
          sort: [{ field: sum("earningsUsd"), direction: "desc" }],
          format: title("Revenue by page"),
        },
        revenueByAgent: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: field("agentName") }],
            valueKey: [sum("earningsUsd")],
            tooltipKey: [],
          },
          sort: [{ field: sum("earningsUsd"), direction: "desc" }],
          format: title("Revenue by agent"),
        },
        live: { type: LIVE_RECEIPTS, dataMapping: {} },
        receipts: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: field("createdAt") },
              { id: field("siteName") },
              { id: field("path") },
              { id: field("agentName") },
              { id: field("amountUsd") },
              { id: field("feeUsd") },
              { id: field("earningsUsd") },
              { id: field("status") },
            ],
          },
          sort: [{ field: { id: field("createdAt") }, direction: "desc" }],
          format: title("Receipts"),
        },
      },
      widgetLayout: {
        revenueToday: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
        paidRequests: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
        uniqueAgents: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 7 },
        averagePrice: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 7 },
        revenueByDay: { xTrack: 0, yTrack: 7, xSpan: 16, ySpan: 19 },
        earnings: { xTrack: 16, yTrack: 7, xSpan: 8, ySpan: 19 },
        revenueByPage: { xTrack: 0, yTrack: 26, xSpan: 8, ySpan: 19 },
        revenueByAgent: { xTrack: 8, yTrack: 26, xSpan: 8, ySpan: 19 },
        live: { xTrack: 16, yTrack: 26, xSpan: 8, ySpan: 19 },
        receipts: { xTrack: 0, yTrack: 45, xSpan: 24, ySpan: 24 },
      },
      filter: {
        widget: {
          revenueToday: [
            {
              field: { id: field("createdAt") },
              model: { operator: "inRelativeRange", value: { type: "this", unit: "day" } },
            },
          ],
        },
      },
    },
  ],
};

/** Suggestions shown in the assistant before the first message. */
export const PROMPT_STARTERS = [
  {
    label: "Top pages this week",
    prompt:
      "Which pages earn the most from AI agents this week? Answer with the top pages and their revenue, then add a bar chart for it on this page.",
  },
  {
    label: "Who pays most",
    prompt: "Which agents spend the most on my sites, and how many requests does each make?",
  },
  {
    label: "Revenue trend",
    prompt: "How is my revenue trending day by day? Call out the best and the worst day.",
  },
  {
    label: "Explain the data",
    prompt: "What fields does this dashboard have, and what does each one measure?",
  },
];
