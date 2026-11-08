import type { Metadata } from "next";
import { headers } from "next/headers";
import { PublisherView } from "@/components/publisher/publisher-view";
import { getDb } from "@/lib/server/db";
import { getPublisherDashboard } from "@/lib/server/publisher";
import { requireUser } from "@/lib/server/session";

export const metadata: Metadata = { title: "Publisher · BotFare" };

/** Publisher home: earnings and PayPal payouts, sites, prices and the middleware snippet. */
export default async function Page() {
  const user = await requireUser();
  const initial = await getPublisherDashboard(getDb(), user.id);
  return <PublisherView initial={initial} botfareUrl={await botfareUrl()} />;
}

/** The URL publishers put in BOTFARE_URL: the configured one, else this request's origin. */
async function botfareUrl(): Promise<string> {
  const configured = process.env.BOTFARE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
