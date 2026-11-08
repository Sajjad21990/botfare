import type { Metadata } from "next";
import { ResearchView } from "@/components/agent/research-view";

export const metadata: Metadata = { title: "Research agent · BotFare" };
export const dynamic = "force-dynamic";

/** The research agent demo: a Claude agent that pays per page over x402 within a budget. */
export default function Page() {
  return <ResearchView />;
}
