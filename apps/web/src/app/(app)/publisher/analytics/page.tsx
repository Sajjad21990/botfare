import type { Metadata } from "next";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { anthropicConfig } from "@/lib/server/analytics-ai";
import { getPublisherAnalytics } from "@/lib/server/analytics-receipts";
import { getDb } from "@/lib/server/db";
import { requireUser } from "@/lib/server/session";

export const metadata: Metadata = { title: "Analytics · BotFare" };

/** Publisher revenue analytics: an AG Studio dashboard over the publisher's own receipts. */
export default async function Page() {
  const user = await requireUser();
  const initial = await getPublisherAnalytics(getDb(), user.id);
  const config = anthropicConfig();
  return (
    // Wider than the app column: dashboards need the room. Centered, with a 24px gutter.
    <div className="relative left-1/2 flex w-[min(calc(100vw-3rem),1680px)] -translate-x-1/2 flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          What AI agents pay to read your sites, live. Built with AG Studio; ask Claude anything
          about your traffic.
        </p>
      </div>
      <AnalyticsView
        initial={initial}
        ai={config ? { available: true, model: config.model } : { available: false }}
      />
    </div>
  );
}
