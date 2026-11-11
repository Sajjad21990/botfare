import type { ReactNode } from "react";
import styles from "./landing.module.css";

/** A rubber stamp: a bordered, slightly rotated word in one ink colour. */
function Stamp({
  children,
  className,
  rotate = "-rotate-6",
}: {
  children: ReactNode;
  className: string;
  rotate?: string;
}) {
  return (
    <span
      className={`inline-block rounded-md border-[3px] px-3 py-1 font-heading text-xl leading-none font-extrabold tracking-wider uppercase ${rotate} ${className}`}
    >
      {children}
    </span>
  );
}

/* Visuals are aria-hidden: each card's heading and sentence say the same thing in words. On ticket
   stock, green is #146b3f (5.7:1) and red is the stamp token (4.9:1). */
const cards: { title: string; body: string; visual: ReactNode }[] = [
  {
    title: "Buys only what's worth it.",
    body: "Reads the free preview, then buys or skips.",
    visual: (
      <div className="flex items-center gap-4">
        <Stamp className="border-[#146b3f] text-[#146b3f]">Buy</Stamp>
        <Stamp className="border-foreground/60 text-foreground/70" rotate="rotate-3">
          Skip
        </Stamp>
      </div>
    ),
  },
  {
    title: "Fare Court: automatic refunds.",
    body: "Paid for a page that wasn't as promised? Clear cases are refunded in seconds; unclear ones go to the site to decide.",
    visual: <Stamp className="border-stamp text-stamp">Refunded 3¢</Stamp>,
  },
  {
    title: "Fare Advisor: pricing tips.",
    body: "Tells a site why agents skipped a page and suggests a price. You click Apply.",
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
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <h2 id="ai-title" className="text-3xl leading-tight font-extrabold sm:text-4xl">
          AI makes the 3¢ decisions
        </h2>
        <p className="mt-3 text-lg">Code still moves the money.</p>
        <ul className="mt-10 grid gap-5 md:grid-cols-3">
          {cards.map((card) => (
            <li key={card.title} className="flex flex-col rounded-2xl border bg-card p-3">
              <div aria-hidden className="grid h-28 place-items-center rounded-xl bg-ticket">
                {card.visual}
              </div>
              <div className="px-3 pt-4 pb-3">
                <h3 className="text-xl font-bold">{card.title}</h3>
                <p className="mt-1.5 leading-relaxed">{card.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
