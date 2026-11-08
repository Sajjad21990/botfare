import type {
  AgBaseRegistry,
  AgBaseWidgetDefinition,
  AgDefaultWidgetDefinition,
  AgWidgetDataFormat,
} from "ag-studio";

/** Widget type IDs of BotFare's custom AG Studio widgets. */
export const LIVE_RECEIPTS = "botfare-live-receipts";
export const EARNINGS_PAYOUT = "botfare-earnings-payout";

/** State of the "Live paid requests" ticker. It reads fields by name, so it has no data mapping. */
export interface LiveReceiptsWidgetState {
  type: typeof LIVE_RECEIPTS;
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<never>;
}

/** State of the "Earnings & payout" card. */
export interface EarningsWidgetState {
  type: typeof EARNINGS_PAYOUT;
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<never>;
}

/** AG Studio's built-in widgets plus BotFare's two custom ones. */
export interface BotFareRegistry extends AgBaseRegistry {
  widgets: readonly (
    | AgDefaultWidgetDefinition
    | AgBaseWidgetDefinition<typeof LIVE_RECEIPTS, LiveReceiptsWidgetState>
    | AgBaseWidgetDefinition<typeof EARNINGS_PAYOUT, EarningsWidgetState>
  )[];
}
