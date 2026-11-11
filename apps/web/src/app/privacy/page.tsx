import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy · BotFare" };

// Linked from the sandbox app's Log in with PayPal settings, which ask for a privacy policy URL.
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-16 text-sm leading-relaxed">
      <p className="font-mono text-muted-foreground">Privacy</p>
      <h1 className="text-2xl font-semibold tracking-tight">What BotFare keeps</h1>
      <p className="text-muted-foreground">
        BotFare is a hackathon demo that runs in the PayPal sandbox only. No real money moves.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <strong>Log in with PayPal:</strong> your verified PayPal email and name, used to sign you
          in and as your payout email. BotFare never sees your PayPal password.
        </li>
        <li>
          <strong>Your account:</strong> your sites, prices, agent keys (public keys only; private
          keys stay in your browser), wallet top-ups, receipts, payouts and disputes.
        </li>
        <li>
          <strong>Cookies:</strong> a signed session cookie, a one-time sign-in state cookie, and on
          publisher sites a 24-hour human-check pass. No advertising or tracking cookies.
        </li>
        <li>
          <strong>Agent signals:</strong> offers shown, decline notes and citations store paths,
          prices and reasons, never IP addresses or user agents. Rate limits hold IP addresses in
          memory only.
        </li>
        <li>
          <strong>AI:</strong> research questions, page text and dispute evidence are sent to the
          configured AI provider to answer them; nothing else is shared.
        </li>
      </ul>
      <p className="text-muted-foreground">
        BotFare does not sell or share your data. Demo data may be deleted after the hackathon.
      </p>
      <div className="flex flex-wrap gap-3 font-medium">
        <Link href="/terms" className="underline underline-offset-4">
          Terms
        </Link>
        <Link href="/" className="underline underline-offset-4">
          Home
        </Link>
      </div>
    </main>
  );
}
