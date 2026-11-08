import { ArrowDownIcon } from "lucide-react";
import styles from "./landing.module.css";
import { pillars } from "./pillar-data";

/** Three ticket stubs that jump to each part of the story. */
export function PillarIndex() {
  return (
    <section aria-labelledby="pillars-title" className="border-b">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <h2
          id="pillars-title"
          className="max-w-2xl text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
        >
          One fare system, three parts
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          The fare moves the money. Fare Court and Fare Advisor put Claude on the two questions that
          come after every fare, and nothing Claude says moves money by itself.
        </p>
        <ul className="mt-12 grid gap-4 md:grid-cols-3">
          {pillars.map((p) => (
            <li key={p.id}>
              <a
                href={`#${p.id}`}
                className={`${styles.ticket} ${styles.focusRing} group flex h-full overflow-hidden rounded-xl border transition-colors hover:border-foreground/40`}
              >
                <span className="flex-1 px-5 py-5">
                  <span className="block text-xl font-bold tracking-tight">{p.name}</span>
                  <span className="mt-2 block font-medium">{p.question}</span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-muted-foreground">
                    {p.summary}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={`${styles.perforated} flex w-12 shrink-0 items-center justify-center text-muted-foreground group-hover:text-foreground`}
                >
                  <ArrowDownIcon className="size-4" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
