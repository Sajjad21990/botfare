import { GlobeIcon, WalletIcon } from "lucide-react";
import type { ReactNode } from "react";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import styles from "./landing.module.css";

const steps: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "The site sets a price.",
    body: "Any page or API call, say 3¢.",
    icon: <GlobeIcon aria-hidden className="size-6" />,
  },
  {
    title: "The agent's owner tops up.",
    body: "With PayPal, plus a daily limit for each agent.",
    icon: <WalletIcon aria-hidden className="size-6" />,
  },
  {
    title: "The agent pays.",
    body: "The site keeps 95%, paid out to PayPal.",
    icon: <BotFareMark className="size-7" />,
  },
];

/** Three ticket stubs: who does what, in the order it happens. */
export function HowSteps() {
  return (
    <section id="how" aria-labelledby="how-title" className={`${styles.anchor} border-b`}>
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <h2 id="how-title" className="text-3xl leading-tight font-extrabold sm:text-4xl">
          How it works
        </h2>
        <ol className="mt-10 grid gap-5 md:grid-cols-3">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className="flex flex-col rounded-2xl border border-foreground/15 bg-ticket"
            >
              <div className="flex items-center justify-between px-5 pt-5 pb-4">
                <span
                  aria-hidden
                  className="grid size-10 place-items-center rounded-full border-[1.5px] border-foreground bg-brand font-heading text-lg font-extrabold"
                >
                  {i + 1}
                </span>
                {step.icon}
              </div>
              <div aria-hidden className="mx-5 border-t-2 border-dashed border-foreground/20" />
              <div className="px-5 pt-4 pb-6">
                <h3 className="text-xl font-bold">{step.title}</h3>
                <p className="mt-1.5 leading-relaxed">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-10 font-heading text-2xl font-extrabold tracking-tight sm:text-3xl">
          People never pay. They just read.
        </p>
      </div>
    </section>
  );
}
