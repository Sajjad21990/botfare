import { Clock, ShieldCheck, TicketIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { demoBaseUrl, demoCommands } from "@/components/judge/demo-commands";
import { PersonaStepButton } from "@/components/judge/persona-step-button";
import { judgeSandboxBuyer, SandboxAccount } from "@/components/judge/sandbox-account";
import { CodeBlock } from "@/components/publisher/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Judge mode · BotFare",
  description: "A two-minute guided tour of BotFare for hackathon judges, in the PayPal sandbox.",
};

// Reads DEMO_PUBLIC_URL and the sandbox buyer at request time, not at build time.
export const dynamic = "force-dynamic";

const REPO_URL = "https://github.com/Sajjad21990/botfare";

export default function JudgePage() {
  const commands = demoCommands(demoBaseUrl(process.env.DEMO_PUBLIC_URL));
  const buyer = judgeSandboxBuyer();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <TicketIcon aria-hidden className="size-5" />
            BotFare
          </Link>
          <Link
            href="/signin"
            className="ml-auto rounded-md px-3 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-12 px-4 py-10 sm:px-6 sm:py-14">
        <section aria-labelledby="judge-title" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Judge mode</Badge>
            <Badge variant="outline">
              <Clock aria-hidden />
              About 2 minutes
            </Badge>
          </div>
          <h1 id="judge-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
            BotFare in two minutes
          </h1>
          <p className="max-w-2xl leading-relaxed text-muted-foreground">
            BotFare is pay-per-request for AI agents, settled on PayPal: x402 for PayPal&apos;s 440
            million accounts. A publisher adds one line of middleware and sets prices; people keep
            reading free, while AI agents get an HTTP 402 with a price and pay a few cents per
            request from a USD wallet their owner topped up with PayPal. BotFare settles every
            request in a double-entry ledger, keeps 5%, and pays publishers out through PayPal
            Payouts.
          </p>
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
            Everything runs in the PayPal sandbox with fake money. You share two demo accounts with
            other judges, so the demo site&apos;s prices reset when you sign in and its secret,
            payout account and seeded agent keys stay locked.
          </p>
        </section>

        <section aria-labelledby="steps-title" className="space-y-4">
          <h2 id="steps-title" className="text-xl font-semibold tracking-tight">
            Try it in three steps
          </h2>
          <ol className="grid gap-4 lg:grid-cols-3">
            <Step
              n={1}
              title="Be the publisher"
              description="Crema Notes, a coffee site, charges AI agents per article."
              points={[
                "Earnings from paid agent requests; Withdraw now is a real sandbox Payout",
                "Fare Advisor: why agents passed on a page, with a one-click price change",
                "Fare Court: disputes the AI judge sent to you, with its reasoning",
                <>
                  <InlineLink href="/publisher/analytics">Analytics (AG Studio)</InlineLink>:
                  revenue by detection signal, cited vs paid
                </>,
              ]}
            >
              <PersonaStepButton persona="publisher" href="/publisher" label="Open the publisher" />
            </Step>
            <Step
              n={2}
              title="Be the agent owner"
              description="Fund a wallet with PayPal and give agents keys with budgets."
              points={[
                "Top up $5 with the PayPal button",
                buyer
                  ? "Approve with the sandbox buyer below"
                  : "Approve with any PayPal sandbox personal account",
                "Agent keys, caps and receipts",
              ]}
            >
              <PersonaStepButton persona="agentOwner" href="/wallet" label="Open the wallet" />
            </Step>
            <Step
              n={3}
              title="Run the research agent"
              description="An AI agent reads 402 offers and decides what to buy."
              points={[
                "Free price check before every purchase; buys or skips with a reason",
                "Fare Court: a paid page that turns out to be a stub gets disputed and refunded",
                "Answer with citations linked to receipts (they feed Fare Advisor)",
                <>
                  Verify sources: each citation&apos;s signed receipt checked in your browser, also
                  at <InlineLink href="/verify">/verify</InlineLink>
                </>,
              ]}
            >
              <PersonaStepButton persona="agentOwner" href="/agent" label="Run the agent" />
            </Step>
          </ol>
          {buyer ? (
            <SandboxAccount email={buyer.email} password={buyer.password} />
          ) : (
            <p className="text-sm text-muted-foreground">
              To approve a top-up, log in to the PayPal window with any PayPal sandbox personal
              account.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Check any receipt at <InlineLink href="/verify">/verify</InlineLink>, plug BotFare into
            your own agent with the{" "}
            <InlineLink href={`${REPO_URL}/tree/main/packages/mcp`}>MCP server</InlineLink>, or read
            the <InlineLink href={REPO_URL}>source on GitHub</InlineLink>.
          </p>
        </section>

        <section aria-labelledby="curl-title" className="space-y-4">
          <div className="space-y-1">
            <h2 id="curl-title" className="text-xl font-semibold tracking-tight">
              See a 402 yourself
            </h2>
            <p className="text-sm text-muted-foreground">
              Run these against the demo site,{" "}
              <a
                href={commands.url}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {commands.url.replace(/^https?:\/\//, "")}
              </a>
              . Nothing is charged: without a signed payment the site only quotes a price.
            </p>
          </div>
          <CurlStep
            title="A person reads free"
            note="Browser headers score as human, so the article comes back with 200."
            code={commands.human}
          />
          <CurlStep
            title="An agent gets a price"
            note="An agent that says so (x-botfare-agent: 1) gets 402 Payment Required with a PAYMENT-REQUIRED header and a preview in the body. A plain curl gets one too: its user agent gives it away."
            code={commands.agent}
          />
          <CurlStep
            title="Decode the offer"
            note="PAYMENT-REQUIRED is base64 JSON (x402 V2): scheme prepaid on network paypal:sandbox, the price in US cents, and the detection signal. Drop the jq if you don't have it."
            code={commands.decode}
          />
        </section>

        <footer className="border-t pt-6 text-sm text-muted-foreground">
          Prefer the usual way in?{" "}
          <Link href="/signin" className="font-medium text-foreground underline underline-offset-4">
            Sign in
          </Link>{" "}
          or read{" "}
          <Link href="/" className="font-medium text-foreground underline underline-offset-4">
            how BotFare works
          </Link>
          .
        </footer>
      </main>
    </div>
  );
}

function Step({
  n,
  title,
  description,
  points,
  children,
}: {
  n: number;
  title: string;
  description: string;
  points: ReactNode[];
  children: ReactNode;
}) {
  return (
    <li className="flex">
      <Card className="flex-1">
        <CardHeader>
          <div className="mb-1 flex size-7 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {n}
          </div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          <ul className="flex-1 space-y-1.5 text-sm">
            {points.map((point, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never reorders
              <li key={i} className="flex gap-2">
                <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          {children}
        </CardContent>
      </Card>
    </li>
  );
}

/** An in-text link: same-site paths use Next's Link, others open as plain anchors. */
function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  const className = "font-medium text-foreground underline underline-offset-4";
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

function CurlStep({ title, note, code }: { title: string; note: string; code: string }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      <CodeBlock code={code} />
    </div>
  );
}
