import { type AgStudioTheme, type AgStudioThemeParams, studioTheme } from "ag-studio";

type Params = Partial<AgStudioThemeParams>;

/**
 * BotFare's AG Studio theme: the app's neutral shadcn look (Geist, near-black on white, hairline
 * borders, 10px radius), with a light and a dark mode chosen through `data-ag-theme-mode`.
 * Colours mirror the oklch tokens in globals.css, written as hex because the theme API needs them.
 */
export const BOTFARE_LIGHT = "botfare-light";
export const BOTFARE_DARK = "botfare-dark";

const FONT = "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif";

/** Calm series colours: teal for money first, then ink, then quiet accents. */
const LIGHT_PALETTE = ["#0f9488", "#404040", "#6366f1", "#d97706", "#a3a3a3", "#e11d48"];
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
  studioWidgetTitleFontFamily: FONT,
  studioWidgetTitleFontSize: 14,
  studioWidgetTitleFontWeight: 500,
  studioWidgetSubtitleFontFamily: FONT,
  studioWidgetCaptionFontFamily: FONT,
  studioCanvasFontFamily: FONT,
  studioPanelHeaderFontFamily: FONT,
  studioPanelHeaderFontWeight: 500,
  studioPopupTitleBarFontFamily: FONT,
  studioValueWidgetFontSize: 28,
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
  backgroundColor: "#ffffff",
  foregroundColor: "#0a0a0a",
  textColor: "#0a0a0a",
  subtleTextColor: "#737373",
  borderColor: "#e5e5e5",
  accentColor: "#171717",
  iconColor: "#525252",
  rowHoverColor: "#f5f5f5",
  menuBackgroundColor: "#ffffff",
  tooltipBackgroundColor: "#171717",
  tooltipTextColor: "#fafafa",
  toggleButtonOnBackgroundColor: "#171717",
  studioWrapperBackgroundColor: "#ffffff",
  studioCanvasBackgroundColor: "#fafafa",
  studioCanvasGridLineColor: "#ececec",
  studioWidgetBackgroundColor: "#ffffff",
  studioWidgetBorder: { width: 1, color: "#e5e5e5" },
  studioWidgetShadow: { offsetY: 1, radius: 2, color: "#0000000d" },
  studioWidgetTitleTextColor: "#0a0a0a",
  studioWidgetSubtitleTextColor: "#737373",
  studioWidgetCaptionTextColor: "#737373",
  studioWidgetSelectedBorderColor: "#171717",
  studioPanelContainerBackgroundColor: "#ffffff",
  studioPanelDividerColor: "#e5e5e5",
  studioToggleButtonActiveBackgroundColor: "#171717",
  studioToggleButtonActiveBorderColor: "#171717",
  studioToggleButtonActiveColor: "#171717",
  studioAiPanelInputMessageBackgroundColor: "#f5f5f5",
  chartTextColor: "#0a0a0a",
  chartSubtleTextColor: "#737373",
  chartAxisLabelColor: "#737373",
  chartGridLineColor: "#f0f0f0",
  chartAxisLineColor: "#e5e5e5",
  chartTooltipBackgroundColor: "#ffffff",
  chartTooltipTextColor: "#0a0a0a",
  gridHeaderBackgroundColor: "#fafafa",
  gridHeaderTextColor: "#525252",
  valueChangeUpColor: "#0d9488",
  valueChangeHighlightBackgroundColor: "#0d948826",
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
