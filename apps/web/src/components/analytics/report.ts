import type {
  AgDataSourcesDefinition,
  AgFieldDefinition,
  AgReportState,
  AgWidgetFieldReference,
} from "ag-studio";
import { SIGNAL_LABELS, UNRECORDED_SIGNAL_LABEL } from "../publisher/detection-copy";
import { type BotFareRegistry, EARNINGS_PAYOUT, LIVE_RECEIPTS } from "./registry";
import type { CitationRow, DeclineRow, ReceiptRow, SignalsData } from "./types";

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

/** Fare Advisor tables: paid reads cited in answers, and offers agents declined. */
export const CITATIONS_TABLE = "citations";
export const DECLINES_TABLE = "declines";

export const citationField = (id: keyof CitationRow): string => `${CITATIONS_TABLE}.${id}`;
export const declineField = (id: keyof DeclineRow): string => `${DECLINES_TABLE}.${id}`;

/** A citation or decline row with a real timestamp and the day in the viewer's time zone. */
export function toStudioSignalRow<T extends { createdAt: string; day: string }>(
  row: T,
): Omit<T, "createdAt"> & { createdAt: Date } {
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
    description: "Path of the paid page or API endpoint, e.g. /recipes/crispy-oven-potatoes.",
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
  {
    id: "detectionSignal",
    name: "Detection signal",
    format: "textFormat",
    description: `Why BotFare asked the request to pay: ${Object.values(SIGNAL_LABELS).join(", ")}, or "${UNRECORDED_SIGNAL_LABEL}" for receipts from before signals were recorded. Revenue by this field is the revenue bot detection recovered.`,
  },
];

const citationFields: AgFieldDefinition[] = [
  { id: "citationId", name: "Citation", format: "textFormat", description: "Citation ID." },
  {
    id: "createdAt",
    name: "Cited at",
    format: "dateTimeFormat",
    formatOptions: { format: "dd mmm, hh:mm:ss" },
    description: "When the agent reported the answer that cited the page.",
  },
  {
    id: "day",
    name: "Cited day",
    format: "dateFormat",
    formatOptions: { format: "dd mmm" },
    description: "Calendar day of the citation, in the viewer's time zone.",
  },
  {
    id: "siteName",
    name: "Cited site",
    format: "textFormat",
    description: "The publisher's site.",
  },
  {
    id: "receiptId",
    name: "Cited receipt",
    format: "textFormat",
    description: "The paid read (receipt) the answer cited; joins receipts.receiptId.",
  },
  { id: "path", name: "Cited page", format: "textFormat", description: "Path of the cited page." },
  {
    id: "agentName",
    name: "Citing agent",
    format: "textFormat",
    description: "Name of the agent key whose answer cited the page.",
  },
  {
    id: "claim",
    name: "Claim",
    format: "textFormat",
    description: "What the answer used the page for, in the agent's words (may be empty).",
  },
];

const declineFields: AgFieldDefinition[] = [
  { id: "declineId", name: "Decline", format: "textFormat", description: "Decline note ID." },
  {
    id: "createdAt",
    name: "Declined at",
    format: "dateTimeFormat",
    formatOptions: { format: "dd mmm, hh:mm:ss" },
    description: "When the agent declined the offer.",
  },
  {
    id: "day",
    name: "Declined day",
    format: "dateFormat",
    formatOptions: { format: "dd mmm" },
    description: "Calendar day of the decline, in the viewer's time zone.",
  },
  {
    id: "siteName",
    name: "Declined site",
    format: "textFormat",
    description: "The publisher's site.",
  },
  {
    id: "path",
    name: "Declined page",
    format: "textFormat",
    description: "Path of the declined page.",
  },
  {
    id: "category",
    name: "Why not",
    format: "textFormat",
    description:
      "Why the agent did not buy: Too expensive, Over budget, Weak preview, Not relevant, Already had it, or Other.",
  },
  {
    id: "reason",
    name: "Agent's reason",
    format: "textFormat",
    description: "The agent's own short reason (untrusted text written by the agent).",
  },
  {
    id: "priceUsd",
    name: "Declined price",
    format: "currencyFormat",
    formatOptions: USD,
    description: "The price the agent saw and declined, in USD.",
  },
];

/**
 * The receipts as an AG Studio data source that accepts live transactions keyed by receipt ID,
 * plus Fare Advisor's citations (joined to receipts) and decline notes.
 */
export function receiptsDataSource(
  rows: ReceiptRow[],
  signals: SignalsData = { citations: [], declines: [] },
): AgDataSourcesDefinition<BotFareRegistry> {
  return {
    description:
      "Paid requests from AI agents to this publisher's sites, settled over x402 on BotFare (pay-per-request on PayPal). One row per receipt. Revenue means the sum of earningsUsd. The citations table lists paid reads that an agent's answer actually used (citations are the new clicks; joined to receipts by receiptId), and the declines table lists offers agents saw and chose not to buy, with their reason.",
    relationships: [
      {
        id: "citationReceipt",
        type: "many-to-one",
        source: `${CITATIONS_TABLE}.receiptId`,
        target: `${RECEIPTS_TABLE}.receiptId`,
      },
    ],
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
      {
        id: CITATIONS_TABLE,
        name: "Citations",
        description:
          "One row per paid read that an agent's answer cited. Count rows per page to see which pages agents actually use.",
        primaryKeyField: "citationId",
        transactions: "all",
        data: signals.citations.map(toStudioSignalRow),
        fields: citationFields,
      },
      {
        id: DECLINES_TABLE,
        name: "Declined offers",
        description:
          "One row per decline note: an agent saw a price offer and said why it did not buy. Reasons are written by agents.",
        primaryKeyField: "declineId",
        transactions: "all",
        data: signals.declines.map(toStudioSignalRow),
        fields: declineFields,
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
 * The dashboard a publisher opens to: KPI tiles, revenue over time, by page, by agent and by
 * detection signal, the live ticker, earnings and payout, and every receipt. 24 columns; rows
 * are 16px.
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
          format: title("Revenue"),
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
        revenueBySignal: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: field("detectionSignal") }],
            valueKey: [sum("earningsUsd")],
            tooltipKey: [],
          },
          sort: [{ field: sum("earningsUsd"), direction: "desc" }],
          format: title("Revenue by detection signal", "Why each paid request was asked to pay"),
        },
        live: { type: LIVE_RECEIPTS, dataMapping: {} },
        citedVsPaid: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: field("path") }],
            valueKey: [
              { id: field("receiptId"), aggregation: "count" },
              { id: citationField("citationId"), aggregation: "count" },
            ],
            tooltipKey: [],
          },
          sort: [{ field: { id: field("receiptId"), aggregation: "count" }, direction: "desc" }],
          format: {
            ...title(
              "Cited vs paid by page",
              "Paid reads (receipts) and how often answers cited them",
            ),
            style: { theme: { common: { legend: { enabled: true, position: "bottom" } } } },
          },
        },
        whyNotBought: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: declineField("category") }],
            valueKey: [{ id: declineField("declineId"), aggregation: "count" }],
            tooltipKey: [],
          },
          sort: [
            { field: { id: declineField("declineId"), aggregation: "count" }, direction: "desc" },
          ],
          format: title("Why agents didn't buy", "Decline notes from agents, by reason"),
        },
        receipts: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: field("createdAt") },
              { id: field("path") },
              { id: field("agentName") },
              { id: field("amountUsd") },
              { id: field("earningsUsd") },
              { id: field("detectionSignal") },
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
        revenueBySignal: { xTrack: 16, yTrack: 26, xSpan: 8, ySpan: 19 },
        receipts: { xTrack: 0, yTrack: 45, xSpan: 16, ySpan: 24 },
        live: { xTrack: 16, yTrack: 45, xSpan: 8, ySpan: 24 },
        citedVsPaid: { xTrack: 0, yTrack: 69, xSpan: 12, ySpan: 19 },
        whyNotBought: { xTrack: 12, yTrack: 69, xSpan: 12, ySpan: 19 },
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
    label: "Revenue recovered",
    prompt:
      "How much revenue did each detection signal bring in? Which signals beyond agents that identify themselves are recovering the most?",
  },
  {
    label: "Why agents skip",
    prompt:
      "Why do agents decline my offers? Group the decline notes by reason and page, and tell me which pages are cited most per paid read.",
  },
  {
    label: "Explain the data",
    prompt: "What fields does this dashboard have, and what does each one measure?",
  },
];
