import type { ReactNode } from "react";
import styles from "./landing.module.css";

/** A rubber stamp: a bordered, slightly rotated word in one ink colour. */
function Stamp({
  children,
  className,
  rotate = "-rotate-6",
  small = false,
}: {
  children: ReactNode;
  className: string;
  rotate?: string;
  small?: boolean;
}) {
  const size = small ? "border-2 px-2 py-0.5 text-sm" : "border-[3px] px-3 py-1 text-2xl";
  return (
    <span
      className={`inline-block rounded-md font-heading leading-none font-extrabold tracking-wider uppercase ${size} ${rotate} ${className}`}
    >
      {children}
    </span>
  );
}

/* The two AI features, right under the hero, with ids for the header anchors. Visuals are
   aria-hidden: each card's name and sentences say the same thing in words. On ticket stock red is
   the stamp token (4.9:1); the Buy stamp's #146b3f sits on card paper (higher still). Facts follow
   DISPUTE_POLICY (autoRefundConfidence 0.8) and applyPriceChange (only after Apply). */
const cards: { id: string; name: string; body: string; visual: ReactNode }[] = [
  {
    id: "fare-court",
    name: "Fare Court",
    body: "Agents can dispute a page that didn't match its offer. If the AI is 80% sure they're right, the 2¢ comes back at once. Close calls go to the site.",
    visual: <Stamp className="border-stamp text-stamp">Refunded 2¢</Stamp>,
  },
  {
    id: "fare-advisor",
    name: "Fare Advisor",
    body: "It reads why agents skipped or disputed your pages and suggests a price. Nothing changes until you click Apply.",
    visual: (
      <div className={`${styles.tabular} flex items-center gap-4 font-heading font-extrabold`}>
        <span className="relative text-3xl text-foreground/55">
          50¢
          <span className="absolute inset-x-[-0.15em] top-1/2 h-[3px] -rotate-12 bg-stamp" />
        </span>
        <span className="rounded-lg border-[1.5px] border-foreground bg-brand px-3 py-1 text-4xl">
          8¢
        </span>
      </div>
    ),
  },
];

export function AiCards() {
  return (
    <section aria-labelledby="ai-title" className="border-b">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <h2 id="ai-title" className="text-2xl leading-tight font-extrabold sm:text-3xl">
          AI judges disputes and suggests prices
        </h2>
        <ul className="mt-8 grid gap-6 md:grid-cols-2">
          {cards.map((card) => (
            <li
              key={card.id}
              id={card.id}
              className={`${styles.anchor} ${styles.printed} flex flex-col overflow-hidden rounded-2xl bg-card`}
            >
              <div className="bg-ticket px-6 pt-6 pb-5">
                <h3 className="font-heading text-4xl leading-none font-extrabold tracking-[-0.02em] sm:text-5xl md:text-4xl lg:text-5xl">
                  {card.name}
                </h3>
                <div aria-hidden className="mt-4 flex h-16 items-center justify-end pr-2">
                  {card.visual}
                </div>
              </div>
              <div aria-hidden className="border-t-2 border-dashed border-foreground/35" />
              <p className="px-6 pt-5 pb-6 text-lg leading-relaxed">{card.body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-col gap-4 rounded-2xl border bg-card px-6 py-5 sm:flex-row sm:items-center sm:gap-6">
          <div aria-hidden className="flex shrink-0 items-center gap-3">
            <Stamp small className="border-[#146b3f] text-[#146b3f]">
              Buy
            </Stamp>
            <Stamp small className="border-foreground/60 text-foreground/70" rotate="rotate-3">
              Skip
            </Stamp>
          </div>
          <p className="leading-relaxed">
            The demo agent reads a free preview, then buys or skips. Code enforces its spending
            limits.
          </p>
        </div>
      </div>
    </section>
  );
}
