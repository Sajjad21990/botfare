"use client";

import type { AgStudioMode } from "ag-studio";
import { Bot, Eye, LayoutDashboard, RefreshCw, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReceiptsResponse } from "./types";

/** AG Studio touches `window` and canvas APIs, so it only ever renders in the browser. */
const StudioDashboard = dynamic(() => import("./studio-dashboard"), {
  ssr: false,
  loading: () => <DashboardSkeleton />,
});

const EMPTY_POLL_MS = 5000;

export interface AnalyticsViewProps {
  initial: ReceiptsResponse;
  /** `provider`: the AI provider's label, e.g. "Anthropic" or "Groq". */
  ai: { available: boolean; model?: string; provider?: string };
}

/** The analytics page body: toolbar, empty state, and the AG Studio dashboard. */
export function AnalyticsView({ initial, ai }: AnalyticsViewProps) {
  const [data, setData] = useState(initial);
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/publisher/analytics/receipts", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as ReceiptsResponse;
        if (body.rows.length > 0) setData(body);
      }
    } finally {
      setChecking(false);
    }
  }, []);

  const empty = data.rows.length === 0;
  useEffect(() => {
    if (!empty) return;
    const id = setInterval(check, EMPTY_POLL_MS);
    return () => clearInterval(id);
  }, [empty, check]);

  if (empty)
    return <EmptyState hasSites={data.siteCount > 0} checking={checking} onCheck={check} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={mode} onValueChange={(value) => setMode(value as AgStudioMode)}>
          <TabsList aria-label="Dashboard mode">
            <TabsTrigger value="view">
              <Eye />
              View
            </TabsTrigger>
            <TabsTrigger value="edit">
              <LayoutDashboard />
              Ask AI
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="hidden text-sm text-muted-foreground md:block">
          {mode === "edit"
            ? "Drag widgets, add charts from the data panel, or ask the assistant on the right."
            : "Click a bar to filter every chart. Switch to Ask AI to ask questions about your traffic."}
        </p>
        <div className="ml-auto">
          {ai.available ? (
            <Badge variant="secondary">
              <Sparkles data-icon="inline-start" />
              {!ai.provider || ai.provider === "Anthropic" ? "Claude" : ai.provider} assistant
            </Badge>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" />}>
                <Bot data-icon="inline-start" />
                AI assistant needs an AI key
              </TooltipTrigger>
              <TooltipContent>
                Set ANTHROPIC_API_KEY (or OPENAI/GEMINI/XAI/GROQ/OPENROUTER_API_KEY, or
                OLLAMA_BASE_URL) on the server and reload.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="h-[calc(100dvh-13rem)] min-h-[560px] overflow-hidden rounded-xl border bg-background">
        <StudioDashboard initial={data} mode={mode} />
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div
      className="grid h-full grid-cols-4 gap-3 p-4"
      role="status"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-24" />
      ))}
      <Skeleton className="col-span-3 h-64" />
      <Skeleton className="h-64" />
      <Skeleton className="col-span-4 h-48" />
    </div>
  );
}

function EmptyState({
  hasSites,
  checking,
  onCheck,
}: {
  hasSites: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Bot className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold tracking-tight">No paid reads yet</h2>
          <p className="text-sm text-muted-foreground">
            {hasSites
              ? "When an AI agent pays for one of your pages, it shows up here within seconds."
              : "Add a site and set prices first; paid reads from AI agents then show up here."}
          </p>
        </div>
        <div className="flex w-full items-start gap-3 rounded-lg border bg-muted/40 p-3 text-left text-sm">
          <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            <Link
              href="/agent"
              className="rounded font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Run the research agent
            </Link>{" "}
            to create some. It pays Saffron &amp; Salt, our demo recipe blog, a few cents a page.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={onCheck} disabled={checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} />
            Check again
          </Button>
          <Link href="/publisher" className={buttonVariants()}>
            {hasSites ? "Set prices" : "Add a site"}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">Checking automatically every few seconds.</p>
      </CardContent>
    </Card>
  );
}
