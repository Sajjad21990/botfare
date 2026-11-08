import { TicketIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { HowVerifyWorks } from "@/components/verify/how-verify-works";
import { ReceiptVerifier } from "@/components/verify/receipt-verifier";
import { isReceiptId } from "@/components/verify/verify-href";

export const metadata: Metadata = {
  title: "Verify a receipt · BotFare",
  description:
    "Check a BotFare receipt: payment, delivery and refund statements, verified in your browser with BotFare's public key.",
};

/** Public: anyone can check a receipt. The signatures are verified in the viewer's browser. */
export default async function VerifyPage({ searchParams }: PageProps<"/verify">) {
  const raw = (await searchParams).receipt;
  const receipt = typeof raw === "string" && isReceiptId(raw.trim()) ? raw.trim() : null;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <TicketIcon aria-hidden className="size-5" />
            BotFare
          </Link>
          <nav aria-label="Main" className="ml-auto flex items-center gap-1 text-sm">
            <Link
              href="/judge"
              className="rounded-md px-3 py-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Two-minute tour
            </Link>
            <Link
              href="/signin"
              className="rounded-md px-3 py-2 font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Verify a receipt</h1>
          <p className="max-w-2xl leading-relaxed text-muted-foreground">
            Every fare BotFare settles comes with statements it signs: what was paid, what was
            delivered and whether it was refunded. Check one here without taking BotFare&apos;s word
            for it: the signatures are verified in your browser with BotFare&apos;s public key.
          </p>
        </div>
        <ReceiptVerifier initialReceipt={receipt} />
        <HowVerifyWorks />
      </main>
    </div>
  );
}
