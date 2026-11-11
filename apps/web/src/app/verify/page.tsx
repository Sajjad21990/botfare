import type { Metadata } from "next";
import Link from "next/link";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { HowVerifyWorks } from "@/components/verify/how-verify-works";
import { ReceiptVerifier } from "@/components/verify/receipt-verifier";
import { isReceiptId } from "@/components/verify/verify-href";
import { exampleReceiptId } from "@/lib/server/verify-example";

export const metadata: Metadata = {
  title: "Verify a receipt · BotFare",
  description:
    "Check the payment, delivery and refund statements BotFare signed for a receipt, in your browser.",
};

/**
 * Public: anyone can check a receipt. The signatures are verified in the viewer's browser. Without
 * ?receipt, the page opens on a real sample receipt from the demo site (lib/server/verify-example),
 * whose banner says the browser checks its signatures.
 */
export default async function VerifyPage({ searchParams }: PageProps<"/verify">) {
  const raw = (await searchParams).receipt;
  const receipt = typeof raw === "string" && isReceiptId(raw.trim()) ? raw.trim() : null;
  const example = receipt ? null : await exampleReceiptId();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <BotFareMark className="size-7" />
            BotFare
          </Link>
          <nav aria-label="Main" className="ml-auto flex items-center gap-1 text-sm">
            <Link
              href="/judge"
              className="rounded-md px-3 py-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Try it in 2 minutes
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

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
        <div className="space-y-3">
          <h1 className="text-4xl leading-[1.05] font-extrabold tracking-[-0.03em] sm:text-5xl">
            Verify a receipt
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
            BotFare signs a statement when an agent pays, when the site delivers the page, and when
            a fare is refunded. Anyone can check them here, in the browser, with BotFare&apos;s
            public key.
          </p>
        </div>
        <ReceiptVerifier
          key={receipt ?? example ?? "empty"}
          initialReceipt={receipt ?? example}
          example={example !== null}
        />
        <HowVerifyWorks />
      </main>
    </div>
  );
}
