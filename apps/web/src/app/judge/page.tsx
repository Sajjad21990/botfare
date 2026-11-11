import { ChartColumn, ChevronDown } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { demoBaseUrl, demoCommands } from "@/components/judge/demo-commands";
import { PersonaStepButton } from "@/components/judge/persona-step-button";
import { SandboxAccount } from "@/components/judge/sandbox-account";
import styles from "@/components/landing/landing.module.css";
import { CodeBlock } from "@/components/publisher/copy-button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Try it in 2 minutes · BotFare",
  description:
    "Three steps, no sign-up: watch an AI agent pay a website a few cents through PayPal, in the PayPal sandbox.",
};

// Reads DEMO_PUBLIC_URL and the sandbox buyer at request time, not at build time.
export const dynamic = "force-dynamic";

const REPO_URL = "https://github.com/Sajjad21990/botfare";

/**
 * The PayPal sandbox buyer a judge uses to approve a wallet top-up: both
 * JUDGE_SANDBOX_BUYER_EMAIL and JUDGE_SANDBOX_BUYER_PASSWORD, or null when either is missing.
 * These are sandbox test credentials (test money), never a real PayPal account.
 */
function judgeSandboxBuyer(env: NodeJS.ProcessEnv = process.env) {
  const email = env.JUDGE_SANDBOX_BUYER_EMAIL?.trim();
  const password = env.JUDGE_SANDBOX_BUYER_PASSWORD?.trim();
  return email && password ? { email, password } : null;
}

const textLink = `${styles.focusRing} rounded-sm font-medium text-foreground underline underline-offset-4`;

export default function JudgePage() {
  const commands = demoCommands(demoBaseUrl(process.env.DEMO_PUBLIC_URL));
  const buyer = judgeSandboxBuyer();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4 sm:px-6">
          <Link
            href="/"
            className={`${styles.focusRing} inline-flex items-center gap-2 rounded-md text-lg font-bold tracking-tight`}
          >
            <BotFareMark className="size-7" />
            BotFare
          </Link>
          <nav aria-label="Main" className="ml-auto flex items-center text-sm">
            <a
              href={REPO_URL}
              className={`${styles.focusRing} hidden rounded-md px-3 py-2 whitespace-nowrap text-muted-foreground hover:text-foreground sm:inline-block`}
            >
              See the code
            </a>
            <Link
              href="/signin"
              className={`${styles.focusRing} rounded-md px-3 py-2 font-medium whitespace-nowrap hover:bg-muted`}
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-10 px-4 py-10 sm:px-6 sm:py-14">
        <section aria-labelledby="judge-title" className="space-y-4">
          <h1
            id="judge-title"
            className="text-4xl leading-[1.05] font-extrabold tracking-[-0.03em] text-balance sm:text-5xl"
          >
            Try BotFare in <span className={styles.highlight}>2 minutes</span>
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed">
            BotFare lets websites charge AI agents a few cents a page, paid through PayPal. People
            still read free. Three steps, no sign-up, all in the PayPal sandbox (test money).
          </p>
        </section>

        <ol aria-label="Three steps" className="grid gap-6 lg:grid-cols-3 lg:gap-y-0">
          <Step
            n={1}
            side="Agent owner"
            title="Watch an AI agent pay"
            action={<PersonaStepButton persona="agentOwner" href="/agent" label="Run the agent" />}
          >
            Ask a coffee question and watch the agent check each page&apos;s price, buy only
            what&apos;s worth it, and ask for its money back when a page isn&apos;t as promised.
          </Step>
          <Step
            n={2}
            side="Publisher"
            title="See the website's side"
            action={
              <>
                <PersonaStepButton
                  persona="publisher"
                  href="/publisher"
                  label="Open the dashboard"
                />
                <PersonaStepButton
                  persona="publisher"
                  href="/publisher/analytics"
                  label="Charts"
                  variant="link"
                  icon={<ChartColumn aria-hidden />}
                />
              </>
            }
          >
            Open Crema Notes, our demo coffee site, to see what agents paid, the one line of code
            that turned it on, prices you can change, and Withdraw to PayPal.
          </Step>
          <Step
            n={3}
            side="Agent owner"
            title="Fund an agent with PayPal"
            action={
              <PersonaStepButton persona="agentOwner" href="/wallet" label="Open the wallet" />
            }
          >
            {buyer
              ? "Top up $5 with the PayPal button and the test account below, then give an agent a key with a daily limit."
              : "Top up $5 with the PayPal button and any PayPal sandbox personal account, then give an agent a key with a daily limit."}
          </Step>
        </ol>

        <SandboxAccount account={buyer} />

        <details className="group rounded-xl border bg-card">
          <summary
            className={`${styles.focusRing} flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden`}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-heading text-base font-semibold">For developers</span>
              <span className="block text-sm text-muted-foreground">
                See a 402 from your terminal, and where the code lives.
              </span>
            </span>
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="space-y-5 border-t px-4 py-4 sm:px-5 sm:py-5">
            <p className="text-sm leading-relaxed">
              Against the demo site,{" "}
              <a href={commands.url} className={cn(textLink, "break-all")}>
                {commands.url.replace(/^https?:\/\//, "")}
              </a>
              . Nothing is charged: without a signed payment the site only quotes a price.
            </p>
            <Command
              code={commands.agent}
              caption="402 Payment Required, with the price and a free preview. A browser gets the article."
            />
            <Command
              code={commands.decode}
              caption="The price header is base64 JSON in the x402 format. Drop the jq if you don't have it."
            />
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <li>
                <InlineLink href="/verify">Verify a receipt</InlineLink>
              </li>
              <li>
                <InlineLink href={`${REPO_URL}/tree/main/packages/mcp`}>
                  Use it from Claude Desktop
                </InlineLink>
              </li>
              <li>
                <InlineLink href={`${REPO_URL}#how-a-paid-request-works`}>
                  How it works in depth
                </InlineLink>
              </li>
              <li>
                <InlineLink href={REPO_URL}>Source</InlineLink>
              </li>
            </ul>
          </div>
        </details>

        <footer className="border-t pt-6 text-sm text-muted-foreground">
          Prefer to look around? <InlineLink href="/signin">Sign in</InlineLink>
          <span aria-hidden> · </span>
          <InlineLink href="/">How BotFare works</InlineLink>
        </footer>
      </main>
    </div>
  );
}

/**
 * One step as a ticket: a yellow numbered stub, a title, one sentence and its action. On wide
 * screens the three cards share rows (subgrid), so the step buttons line up.
 */
function Step({
  n,
  side,
  title,
  action,
  children,
}: {
  n: number;
  side: string;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid min-w-0 lg:row-span-4 lg:grid-rows-subgrid">
      <article
        aria-labelledby={`step-${n}-title`}
        className={cn(
          styles.printed,
          "row-span-4 grid grid-rows-subgrid gap-0 overflow-hidden rounded-xl bg-card",
        )}
      >
        <div
          aria-hidden
          className="flex items-center justify-between gap-3 border-b-2 border-dashed border-foreground/40 bg-brand px-5 py-3"
        >
          <span className="font-heading text-4xl leading-none font-extrabold">{n}</span>
          <span className="text-xs font-semibold tracking-[0.14em] uppercase">{side}</span>
        </div>
        <h2 id={`step-${n}-title`} className="px-5 pt-5 text-xl font-bold tracking-tight">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h2>
        <p className="px-5 pt-2 leading-relaxed">{children}</p>
        <div className="flex flex-col items-center gap-1 px-5 pt-5 pb-5">{action}</div>
      </article>
    </li>
  );
}

/** An in-text link: same-site paths use Next's Link, others open as plain anchors. */
function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={textLink}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={textLink}>
      {children}
    </a>
  );
}

function Command({ code, caption }: { code: string; caption: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <CodeBlock code={code} />
      <p className="text-sm text-muted-foreground">{caption}</p>
    </div>
  );
}
