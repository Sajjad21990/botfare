import type { Metadata } from "next";
import { DisputesView } from "@/components/publisher/disputes-view";
import { getPublisherDisputes } from "@/lib/server/fare-court-api";
import { requireUser } from "@/lib/server/session";

export const metadata: Metadata = { title: "Disputes · BotFare" };
export const dynamic = "force-dynamic";

/** Fare Court for publishers: disputes on their sites, the AI's reasoning, accept or decline. */
export default async function Page() {
  const user = await requireUser();
  const initial = await getPublisherDisputes(user.id);
  return <DisputesView initial={initial} />;
}
