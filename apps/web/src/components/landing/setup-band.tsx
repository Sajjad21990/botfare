import { DEMO_SITE_PRICING, type PricingRule } from "@botfare/contracts";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CodeTabs } from "./code-tabs";
import styles from "./landing.module.css";
import { MCP_README_URL, REPO_URL } from "./links";

/** Keywords and punctuation, dimmed. */
function K({ children }: { children: ReactNode }) {
  return <span className="text-background/60">{children}</span>;
}

/** Strings, in ticket yellow (12:1 on the ink code block). */
function S({ children }: { children: ReactNode }) {
  return <span className="text-brand">{children}</span>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre
      className={`${styles.code} min-h-[8.5rem] rounded-xl bg-foreground px-4 py-4 text-xs leading-relaxed text-background sm:text-[0.8125rem] lg:text-xs`}
    >
      <code>{children}</code>
    </pre>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm">{children}</p>;
}

/* The exact code a site and an agent write: `botfare` and `createBotFareAgent` with their real
   options (packages/express/src/index.ts, packages/sdk/src/agent.ts); BOTFARE_URL comes from env. */
const websiteCode = (
  <Code>
    <K>import</K> {"{ botfare } "}
    <K>from</K> <S>&quot;@botfare/express&quot;</S>;{"\n\n"}
    {"app.use(botfare({ siteId, siteSecret }));"}
  </Code>
);

const agentCode = (
  <Code>
    <K>import</K> {"{ createBotFareAgent } "}
    <K>from</K> <S>&quot;@botfare/sdk&quot;</S>;{"\n\n"}
    <K>const</K> {"agent = createBotFareAgent({ agentKey, maxPerRequestUsd: 0.10 });\n"}
    <K>const</K> {"{ response, paid } = "}
    <K>await</K> {"agent.fetch(\n  "}
    <S>&quot;https://botfare-demo.onrender.com/articles/burr-basics&quot;</S>
    {",\n);"}
  </Code>
);

const linkClass = `${styles.focusRing} rounded-sm font-semibold underline underline-offset-4`;

/** The demo site's real prices, in the order a reader meets them. */
const SHOWN_PATTERNS = ["/articles/*", "/articles/premium-*", "/api/brew-ratio"];

const shownRules = SHOWN_PATTERNS.map((pattern) =>
  DEMO_SITE_PRICING.find((rule) => rule.pattern === pattern),
).filter((rule): rule is PricingRule => rule !== undefined);

function formatPrice(cents: number): string {
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`;
}

const checks = [
  "Change a price; it's live in 30 seconds",
  "See what every agent paid",
  "Cash out to PayPal any time",
];

/** The page's one yellow band: the code a site adds, and the dashboard that runs it. */
export function SetupBand() {
  return (
    <section
      id="setup"
      aria-labelledby="setup-title"
      className={`${styles.anchor} border-y-[1.5px] border-foreground bg-brand`}
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <h2
          id="setup-title"
          className="max-w-3xl text-3xl leading-tight font-extrabold text-balance sm:text-5xl"
        >
          One line to add. One dashboard to run.
        </h2>
        <p className="mt-4 text-lg">No checkout pages, no crypto, no prices in your code.</p>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr]">
          <div className={`${styles.printed} min-w-0 rounded-2xl bg-card p-4 sm:p-6`}>
            <h3 className="mb-4 text-xl font-bold">Add it to your code</h3>
            <CodeTabs
              label="Show the code for"
              tabs={[
                {
                  id: "website",
                  label: "Your website",
                  panel: (
                    <>
                      {websiteCode}
                      <Caption>Keys come from your dashboard.</Caption>
                    </>
                  ),
                },
                {
                  id: "agent",
                  label: "Your AI agent",
                  panel: (
                    <>
                      {agentCode}
                      <Caption>
                        Charged only when the page is delivered. Using Claude? Add the{" "}
                        <a href={MCP_README_URL} className={linkClass}>
                          MCP server
                        </a>
                        .
                      </Caption>
                    </>
                  ),
                },
              ]}
            />
          </div>

          <div className={`${styles.printed} min-w-0 rounded-2xl bg-card p-4 sm:p-6`}>
            <h3 className="text-xl font-bold">Run it from one dashboard</h3>
            <table className="mt-4 w-full text-left text-sm">
              <caption className="mb-2 text-left text-sm text-muted-foreground">
                Prices on Crema Notes, our demo site
              </caption>
              <thead>
                <tr className="border-b-[1.5px] border-foreground">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Path
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-semibold">
                    Price
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Who pays
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownRules.map((rule) => (
                  <tr key={rule.pattern} className="border-b border-dashed border-foreground/20">
                    <td className={`${styles.mono} py-2.5 pr-3 text-[0.8125rem] break-all`}>
                      {rule.pattern}
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      <span
                        className={`${styles.tabular} inline-block rounded-md bg-ticket px-2 py-0.5 font-bold`}
                      >
                        {formatPrice(rule.priceCents)}
                      </span>
                    </td>
                    <td className="py-2.5 whitespace-nowrap">
                      {rule.audience === "everyone" ? "Everyone" : "AI agents"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="mt-5 space-y-2.5">
              {checks.map((check) => (
                <li key={check} className="flex items-start gap-2.5">
                  <CheckIcon
                    aria-hidden
                    strokeWidth={3}
                    className="mt-0.5 size-5 shrink-0 text-success"
                  />
                  {check}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-8 text-base">
          Open source (MIT).{" "}
          <a href={REPO_URL} className={linkClass}>
            Install from GitHub
          </a>{" "}
          (not on npm yet).
        </p>
      </div>
    </section>
  );
}
