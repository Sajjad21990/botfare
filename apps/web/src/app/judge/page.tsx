import { ChartColumn, ChevronDown } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { NewTabLink } from "@/components/app/external-link";
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
    "Watch an AI agent pay a website a few cents through PayPal. It takes three steps in the sandbox, with no account.",
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
            <NewTabLink
              href={REPO_URL}
              icon
              className={`${styles.focusRing} hidden items-center gap-1 rounded-md px-3 py-2 whitespace-nowrap text-muted-foreground hover:text-foreground sm:inline-flex`}
            >
              See the code
            </NewTabLink>
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
            BotFare lets websites charge AI agents a few cents a page through PayPal. People read
            free. Everything here uses PayPal sandbox test money. You don&apos;t need an account.
          </p>
        </section>

        <ol aria-label="Three steps" className="grid gap-6 lg:grid-cols-3 lg:gap-y-0">
          <Step
            n={1}
            side="Agent owner"
            title="Watch an AI agent pay"
            action={<PersonaStepButton persona="agentOwner" href="/agent" label="Run the agent" />}
          >
            Ask a coffee question. The agent pays 3¢ or 5¢ for each page worth reading. If a page
            doesn&apos;t match its preview, Fare Court&apos;s AI judge rules on a refund.
          </Step>
          <Step
            n={2}
            side="Publisher"
            title="See what the website earns"
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
            Crema Notes is our demo coffee blog. It keeps 95% of what agents pay and withdraws to
            PayPal. Fare Advisor suggests prices, and a price changes only when you click Apply.
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
              ? "Top up $5 with the PayPal button and the test account below. Then give an agent a key with a daily cap."
              : "Top up $5 with the PayPal button and any PayPal sandbox personal account. Then give an agent a key with a daily cap."}
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
                Get a 402 with curl, and find the code.
              </span>
            </span>
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="space-y-5 border-t px-4 py-4 sm:px-5 sm:py-5">
            <p className="text-sm leading-relaxed">
              Both commands ask the demo site for{" "}
              <NewTabLink href={commands.url} className={cn(textLink, "break-all")}>
                {commands.url.replace(/^https?:\/\//, "")}
              </NewTabLink>
              . Without a signed payment the site quotes a price and charges nothing.
            </p>
            <Command
              code={commands.agent}
              caption="Returns 402 Payment Required with the price and a free preview. A browser gets the full article."
            />
            <Command
              code={commands.decode}
              caption="Decodes the price header, which is base64 JSON in the x402 format. Without jq, delete the last pipe."
            />
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <li>
                <InlineLink href="/verify" newTab>
                  Verify a receipt
                </InlineLink>
              </li>
              <li>
                <InlineLink href={`${REPO_URL}/tree/main/packages/mcp#readme`}>
                  MCP server for Claude Desktop
                </InlineLink>
              </li>
              <li>
                <InlineLink href={`${REPO_URL}#how-a-paid-request-works`}>
                  How a paid request works
                </InlineLink>
              </li>
              <li>
                <InlineLink href={REPO_URL}>Source on GitHub</InlineLink>
              </li>
            </ul>
          </div>
        </details>

        <footer className="border-t pt-6 text-sm text-muted-foreground">
          You can also <InlineLink href="/signin">sign in</InlineLink> as either side, or read{" "}
          <InlineLink href="/">how BotFare works</InlineLink>.
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

/**
 * An in-text link. Same-site paths use Next's Link in this tab; other sites, and same-site side
 * trips marked `newTab`, open in a new tab with a small arrow.
 */
function InlineLink({
  href,
  newTab = false,
  children,
}: {
  href: string;
  newTab?: boolean;
  children: ReactNode;
}) {
  if (href.startsWith("/") && !newTab) {
    return (
      <Link href={href} className={textLink}>
        {children}
      </Link>
    );
  }
  return (
    <NewTabLink href={href} icon className={cn(textLink, "inline-flex items-center gap-0.5")}>
      {children}
    </NewTabLink>
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
