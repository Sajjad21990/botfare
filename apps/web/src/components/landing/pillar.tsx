import type { ReactNode } from "react";
import styles from "./landing.module.css";
import { type PillarId, pillars } from "./pillar-data";

type PillarProps = {
  id: PillarId;
  /** Who uses this part of BotFare. */
  forWhom: string;
  /** What it does, a few short paragraphs or a list. */
  children: ReactNode;
  /** The worked example, drawn on the right on wide screens. */
  example: ReactNode;
  tinted?: boolean;
};

/** One of the three parts: name, the question it answers, who it is for, and a worked example. */
export function Pillar({ id, forWhom, children, example, tinted }: PillarProps) {
  const pillar = pillars.find((p) => p.id === id);
  if (!pillar) return null;
  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={`${styles.anchor} border-b ${tinted ? "bg-muted/40" : ""}`}
    >
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] lg:gap-16">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="text-4xl leading-[1] font-extrabold tracking-[-0.03em] sm:text-5xl"
          >
            {pillar.name}
          </h2>
          <p className="mt-4 text-2xl leading-snug font-semibold tracking-tight text-balance text-muted-foreground sm:text-3xl">
            {pillar.question}
          </p>
          <p className="mt-6 text-sm">
            <span className="text-muted-foreground">For </span>
            <span className="font-semibold">{forWhom}</span>
          </p>
          <div className="mt-6 max-w-[62ch] space-y-4 leading-relaxed">{children}</div>
        </div>
        <div className="min-w-0 self-start lg:pt-2">{example}</div>
      </div>
    </section>
  );
}

/** A short list of facts inside a pillar. */
export function PillarPoints({ points }: { points: ReactNode[] }) {
  return (
    <ul className="space-y-3">
      {points.map((point, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, static list
          key={i}
          className="relative pl-5 text-muted-foreground before:absolute before:top-[0.7em] before:left-0 before:h-0.5 before:w-2.5 before:bg-foreground/50"
        >
          {point}
        </li>
      ))}
    </ul>
  );
}
