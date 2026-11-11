import type { Metadata } from "next";
import Link from "next/link";
import { NewTabLink } from "@/components/app/external-link";

export const metadata: Metadata = { title: "Terms · BotFare" };

// Linked from the sandbox app's Log in with PayPal settings, which ask for a user agreement URL.
export default function TermsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-16 text-sm leading-relaxed">
      <p className="font-mono text-muted-foreground">Terms</p>
      <h1 className="text-2xl font-semibold tracking-tight">Using the BotFare demo</h1>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          BotFare is a hackathon demo, provided as is, without warranty. It runs in the PayPal
          sandbox only: balances, top-ups, fares and payouts are test money.
        </li>
        <li>
          The demo personas are shared by everyone who tries the demo. Don't enter anything private
          in them.
        </li>
        <li>
          Don't use the demo to attack, overload or scrape other services. BotFare may reset demo
          data or revoke keys at any time.
        </li>
        <li>
          The source code is on{" "}
          <NewTabLink
            href="https://github.com/Sajjad21990/botfare"
            className="underline underline-offset-4"
          >
            GitHub
          </NewTabLink>{" "}
          under the MIT license.
        </li>
      </ul>
      <div className="flex flex-wrap gap-3 font-medium">
        <Link href="/privacy" className="underline underline-offset-4">
          Privacy
        </Link>
        <Link href="/" className="underline underline-offset-4">
          Home
        </Link>
      </div>
    </main>
  );
}
