import { type AgStudioTheme, type AgStudioThemeParams, studioTheme } from "ag-studio";

type Params = Partial<AgStudioThemeParams>;

/**
 * BotFare's AG Studio theme: the app's "Ticket booth" look (cream ticket paper, ticket yellow, warm
 * ink, Inter with Bricolage Grotesque titles), with a light and a dark mode chosen through
 * `data-ag-theme-mode`. Colours mirror the tokens in globals.css.
 */
export const BOTFARE_LIGHT = "botfare-light";
export const BOTFARE_DARK = "botfare-dark";

const FONT = "var(--font-body), ui-sans-serif, system-ui, sans-serif";
const DISPLAY = "var(--font-display), var(--font-body), ui-sans-serif, sans-serif";

/** Series colours, as in globals.css: mustard for money first, then ink, teal, terracotta, warm grey. */
const LIGHT_PALETTE = ["#a87d00", "#1c1a16", "#2a7f74", "#c2542d", "#8c8270", "#ffd44d"];
const DARK_PALETTE = ["#22b3a2", "#d4d4d4", "#818cf8", "#fbbf24", "#737373", "#fb7185"];

function palette(colors: string[]): Params {
  const params: Record<string, string> = {};
  colors.forEach((color, index) => {
    params[`chartPaletteFills${index + 1}Color`] = color;
    params[`chartPaletteStrokes${index + 1}Color`] = color;
  });
  return params as Params;
}

const shared = {
  fontFamily: FONT,
  fontSize: 13,
  borderRadius: 8,
  // Phones: Studio and the page may shrink below their 600px / 720px defaults.
  studioMinWidth: 0,
  studioMinHeight: 480,
  studioWidgetBorderRadius: 10,
  studioWidgetPadding: 6,
  studioWidgetTitleFontFamily: DISPLAY,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 700,
  studioWidgetSubtitleFontFamily: FONT,
  studioWidgetCaptionFontFamily: FONT,
  studioCanvasFontFamily: FONT,
  studioPanelHeaderFontFamily: FONT,
  studioPanelHeaderFontWeight: 500,
  studioPopupTitleBarFontFamily: FONT,
  studioValueWidgetFontSize: 30,
  chartFontFamily: FONT,
  chartAxisLabelFontFamily: FONT,
  chartAxisTitleFontFamily: FONT,
  chartSeriesLabelFontFamily: FONT,
  chartLegendLabelFontFamily: FONT,
  chartGridLineWidth: 1,
  chartAxisLineWidth: 0,
  gridRowHeight: 36,
  gridFontFamily: FONT,
} satisfies Params;

const light = {
  ...shared,
  browserColorScheme: "light",
  backgroundColor: "#fffdf7",
  foregroundColor: "#1c1a16",
  textColor: "#1c1a16",
  subtleTextColor: "#6b6250",
  borderColor: "#e8dcbc",
  accentColor: "#1c1a16",
  iconColor: "#4a4334",
  rowHoverColor: "#ffeaa3",
  menuBackgroundColor: "#fffdf7",
  tooltipBackgroundColor: "#1c1a16",
  tooltipTextColor: "#ffd44d",
  toggleButtonOnBackgroundColor: "#1c1a16",
  studioWrapperBackgroundColor: "#fffdf7",
  studioCanvasBackgroundColor: "#fff8e6",
  studioCanvasGridLineColor: "#f1e6c9",
  studioWidgetBackgroundColor: "#fffdf7",
  studioWidgetBorder: { width: 1, color: "#e8dcbc" },
  studioWidgetShadow: { offsetY: 1, radius: 2, color: "#1c1a160d" },
  studioWidgetTitleTextColor: "#1c1a16",
  studioWidgetSubtitleTextColor: "#6b6250",
  studioWidgetCaptionTextColor: "#6b6250",
  studioWidgetSelectedBorderColor: "#1c1a16",
  studioPanelContainerBackgroundColor: "#fffdf7",
  studioPanelDividerColor: "#e8dcbc",
  studioToggleButtonActiveBackgroundColor: "#1c1a16",
  studioToggleButtonActiveBorderColor: "#1c1a16",
  studioToggleButtonActiveColor: "#1c1a16",
  studioAiPanelInputMessageBackgroundColor: "#f7edcf",
  chartTextColor: "#1c1a16",
  chartSubtleTextColor: "#6b6250",
  chartAxisLabelColor: "#6b6250",
  chartGridLineColor: "#f1e6c9",
  chartAxisLineColor: "#e8dcbc",
  chartTooltipBackgroundColor: "#fffdf7",
  chartTooltipTextColor: "#1c1a16",
  gridHeaderBackgroundColor: "#f7edcf",
  gridHeaderTextColor: "#4a4334",
  valueChangeUpColor: "#2f6f6a",
  valueChangeHighlightBackgroundColor: "#ffd44d55",
  ...palette(LIGHT_PALETTE),
} satisfies Params;

const dark = {
  ...shared,
  browserColorScheme: "dark",
  backgroundColor: "#171717",
  foregroundColor: "#fafafa",
  textColor: "#fafafa",
  subtleTextColor: "#a1a1a1",
  borderColor: "#ffffff1a",
  accentColor: "#e5e5e5",
  iconColor: "#a1a1a1",
  rowHoverColor: "#262626",
  menuBackgroundColor: "#171717",
  tooltipBackgroundColor: "#fafafa",
  tooltipTextColor: "#171717",
  toggleButtonOnBackgroundColor: "#e5e5e5",
  studioWrapperBackgroundColor: "#0a0a0a",
  studioCanvasBackgroundColor: "#0a0a0a",
  studioCanvasGridLineColor: "#1f1f1f",
  studioWidgetBackgroundColor: "#171717",
  studioWidgetBorder: { width: 1, color: "#ffffff1a" },
  studioWidgetShadow: { offsetY: 0, radius: 0, color: "#00000000" },
  studioWidgetTitleTextColor: "#fafafa",
  studioWidgetSubtitleTextColor: "#a1a1a1",
  studioWidgetCaptionTextColor: "#a1a1a1",
  studioWidgetSelectedBorderColor: "#e5e5e5",
  studioPanelContainerBackgroundColor: "#171717",
  studioPanelDividerColor: "#ffffff1a",
  studioToggleButtonActiveBackgroundColor: "#e5e5e5",
  studioToggleButtonActiveBorderColor: "#e5e5e5",
  studioToggleButtonActiveColor: "#e5e5e5",
  studioAiPanelInputMessageBackgroundColor: "#262626",
  chartTextColor: "#fafafa",
  chartSubtleTextColor: "#a1a1a1",
  chartAxisLabelColor: "#a1a1a1",
  chartGridLineColor: "#262626",
  chartAxisLineColor: "#ffffff1a",
  chartTooltipBackgroundColor: "#171717",
  chartTooltipTextColor: "#fafafa",
  gridHeaderBackgroundColor: "#1c1c1c",
  gridHeaderTextColor: "#a1a1a1",
  valueChangeUpColor: "#2dd4bf",
  valueChangeHighlightBackgroundColor: "#2dd4bf26",
  ...palette(DARK_PALETTE),
} satisfies Params;

/** Built once; switch modes by setting `data-ag-theme-mode` on an `.ag-theme-mode` ancestor. */
export const botfareTheme: AgStudioTheme = studioTheme
  .withParams(light, BOTFARE_LIGHT)
  .withParams(dark, BOTFARE_DARK);
