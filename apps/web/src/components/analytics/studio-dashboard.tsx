"use client";

import {
  type AgAiHarnessSetup,
  type AgCoreDefaultRegistry,
  type AgPanelConfig,
  type AgResponsiveLayoutBreakpoint,
  AgStudioAiModule,
  type AgStudioApi,
  type AgStudioMode,
  type AgWidgetsConfig,
  createAiHarness,
  enableStudioDevValidations,
  singleColumnLayout,
} from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { claudeAdapter } from "./claude-adapter";
import { setLiveState } from "./live-store";
import { type BotFareRegistry, EARNINGS_PAYOUT, LIVE_RECEIPTS } from "./registry";
import {
  initialReport,
  PROMPT_STARTERS,
  RECEIPTS_TABLE,
  receiptsDataSource,
  toStudioRow,
} from "./report";
import { BOTFARE_DARK, BOTFARE_LIGHT, botfareTheme } from "./theme";
import type { ReceiptRow, ReceiptsResponse } from "./types";
import { EarningsWidget, LiveReceiptsWidget } from "./widgets";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

/** Unset: AG Studio runs unlicensed, with its watermark and a console notice. */
const LICENSE_KEY = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY || undefined;
const POLL_MS = 4000;
const POLL_LIMIT = 50;

const adapter = claudeAdapter({ endpoint: "/api/publisher/analytics/ai" });

// The setup hands over the core API type; at runtime it is the full browser Studio API.
const ai: AgAiHarnessSetup = ({ api }) =>
  createAiHarness(api as unknown as AgStudioApi, { adapter, promptStarters: PROMPT_STARTERS });

const RADIO_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>';
const WALLET_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/></svg>';

/** Adds BotFare's two custom widgets to the widget menu, ahead of AG Studio's own. */
const widgets = (config: AgWidgetsConfig<AgCoreDefaultRegistry>) =>
  createWidgets<BotFareRegistry>({
    additionalTypes: [
      {
        id: LIVE_RECEIPTS,
        label: "Live paid requests",
        icon: RADIO_ICON,
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: LiveReceiptsWidget,
        defaultSize: { width: 360, height: 300 },
        minSize: { width: 240, height: 200 },
        ai: {
          description:
            "A live ticker of the newest paid requests (page, agent, price), updating as agents pay. Respects page filters and cross filters.",
          usage: "Use to watch AI agent traffic arrive in real time. It needs no fields.",
        },
      },
      {
        id: EARNINGS_PAYOUT,
        label: "Earnings & payout",
        icon: WALLET_ICON,
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: EarningsWidget,
        defaultSize: { width: 360, height: 280 },
        minSize: { width: 240, height: 220 },
        ai: {
          description:
            "The publisher's withdrawable earnings balance, what the filtered view earned and paid in fees, and a button to withdraw with PayPal.",
          usage: "Use when the user asks about their balance or getting paid. It needs no fields.",
        },
      },
    ],
    menu: [
      { label: "BotFare", widgetIds: [LIVE_RECEIPTS, EARNINGS_PAYOUT] },
      ...(config.menu as AgWidgetsConfig<BotFareRegistry>["menu"]),
    ],
  });

/** Collapse panels the reader does not need; view mode keeps only filters. */
const panels: AgPanelConfig = {
  view: { right: ["filters"] },
  edit: { left: ["data"], right: ["ai", "edit", "filters"] },
};

/** On narrow screens (view mode), stack every widget in one column. */
const breakpoints: AgResponsiveLayoutBreakpoint[] = [{ maxWidth: 640, layout: singleColumnLayout }];
const pageLayout = { minWidth: 320 };

function useStudioThemeMode(): string {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark ? BOTFARE_DARK : BOTFARE_LIGHT;
}

function rowChanged(a: ReceiptRow, b: ReceiptRow): boolean {
  return a.status !== b.status || a.earningsUsd !== b.earningsUsd;
}

export interface StudioDashboardProps {
  initial: ReceiptsResponse;
  mode: AgStudioMode;
}

/**
 * The publisher's revenue dashboard in AG Studio: BotFare theme, a designed initial layout, two
 * custom widgets, live data through engine transactions, and a Claude assistant through the
 * Agent Framework. Client-only (loaded with `ssr: false`).
 */
export default function StudioDashboard({ initial, mode }: StudioDashboardProps) {
  const studioRef = useRef<AgStudio<BotFareRegistry>>(null);
  const known = useRef(new Map(initial.rows.map((row) => [row.receiptId, row])));
  const [ready, setReady] = useState(false);
  const themeMode = useStudioThemeMode();
  // Read once: Studio owns the data from here and receives changes as transactions.
  const [data] = useState(() => receiptsDataSource(initial.rows));
  const style = useMemo(() => ({ height: "100%", width: "100%" }), []);

  useEffect(() => {
    setLiveState({
      earningsUsd: initial.earnings.balanceUsd,
      lastSyncAt: Date.now(),
      online: true,
    });
  }, [initial]);

  const poll = useCallback(async () => {
    const engine = studioRef.current?.api?.getDataEngine();
    if (!engine?.applyTransaction) return;
    try {
      const res = await fetch(`/api/publisher/analytics/receipts?limit=${POLL_LIMIT}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ReceiptsResponse;
      const add: ReceiptRow[] = [];
      const update: ReceiptRow[] = [];
      for (const row of body.rows) {
        const previous = known.current.get(row.receiptId);
        if (!previous) add.push(row);
        else if (rowChanged(previous, row)) update.push(row);
      }
      if (add.length || update.length) {
        await engine.applyTransaction({
          tableId: RECEIPTS_TABLE,
          add: add.map(toStudioRow),
          update: update.map(toStudioRow),
        });
        for (const row of [...add, ...update]) known.current.set(row.receiptId, row);
      }
      setLiveState({
        earningsUsd: body.earnings.balanceUsd,
        lastSyncAt: Date.now(),
        online: true,
        ...(add.length ? { freshIds: add.map((row) => row.receiptId).slice(0, 20) } : {}),
      });
    } catch {
      setLiveState({ online: false });
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      if (document.visibilityState === "visible") await poll();
      if (!stopped) timer = setTimeout(loop, POLL_MS);
    };
    timer = setTimeout(loop, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ready, poll]);

  // Studio does not re-measure its canvas when the mode (and so the set of panels) changes;
  // a resize event makes it fill the space the panels left or took.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on purpose whenever `mode` changes
  useEffect(() => {
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    const later = setTimeout(() => window.dispatchEvent(new Event("resize")), 250);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
    };
  }, [mode]);

  return (
    <AgStudioProvider modules={[AgStudioAiModule]} licenseKey={LICENSE_KEY}>
      <div className="ag-theme-mode h-full w-full" data-ag-theme-mode={themeMode}>
        <AgStudio<BotFareRegistry>
          ref={studioRef}
          style={style}
          theme={botfareTheme}
          loadThemeGoogleFonts={false}
          data={data}
          initialState={initialReport}
          widgets={widgets}
          mode={mode}
          panels={panels}
          layout={pageLayout}
          responsiveLayoutBreakpoints={breakpoints}
          enableFilterEditingInViewMode
          ai={ai}
          onStudioReady={() => setReady(true)}
        />
      </div>
    </AgStudioProvider>
  );
}
