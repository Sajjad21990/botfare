"use client";

import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import { ArrowRight, Bot, Globe, Loader2, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import styles from "@/components/landing/landing.module.css";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What each side does, in a visitor's words. */
const SIDES: Record<DemoPersona, { title: string; blurb: string; Icon: LucideIcon }> = {
  publisher: {
    title: "I run a website",
    blurb:
      "Sign in as Crema Notes, our demo coffee blog. Agents pay from 3¢ an article, and you keep 95%.",
    Icon: Globe,
  },
  agentOwner: {
    title: "I run AI agents",
    blurb:
      "Your agents spend from a wallet you top up with PayPal. The demo key pays at most 10¢ a page.",
    Icon: Bot,
  },
};

/** Judge mode: one click signs in as a demo persona. Each persona is a ticket with a stub. */
export function PersonaButtons() {
  const router = useRouter();
  const [pending, setPending] = useState<DemoPersona | null>(null);

  async function signIn(persona: DemoPersona) {
    setPending(persona);
    try {
      const response = await fetch("/api/session/persona", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const { home } = (await response.json()) as { home: string };
      router.push(home);
      router.refresh();
    } catch {
      setPending(null);
      toast.error("Could not sign in. Try again in a moment.");
    }
  }

  return (
    <ul className="grid gap-5 sm:grid-cols-2">
      {(Object.keys(DEMO_PERSONAS) as DemoPersona[]).map((persona) => {
        const { label } = DEMO_PERSONAS[persona];
        const { title, blurb, Icon } = SIDES[persona];
        const busy = pending === persona;
        return (
          <li key={persona} className="flex min-w-0">
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => signIn(persona)}
              className={cn(
                styles.printed,
                styles.focusRing,
                "group flex flex-1 overflow-hidden rounded-xl bg-card text-left transition-transform",
                "motion-safe:enabled:hover:-translate-y-0.5 disabled:cursor-default",
                pending !== null && !busy && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-2 p-5">
                <Icon aria-hidden className="size-6" />
                <span className="font-heading text-xl leading-tight font-bold sm:text-2xl">
                  {title}
                </span>
                <span className="text-sm leading-relaxed">{blurb}</span>
              </span>
              <span className="flex w-24 shrink-0 flex-col items-center justify-center gap-2 border-l-2 border-dashed border-foreground/40 bg-brand px-2 text-center sm:w-28">
                <span className="text-sm leading-tight font-bold">
                  {busy ? "Signing in…" : label}
                </span>
                {busy ? (
                  <Loader2 aria-hidden className="size-5 animate-spin" />
                ) : (
                  <ArrowRight
                    aria-hidden
                    className="size-5 transition-transform motion-safe:group-enabled:group-hover:translate-x-0.5"
                  />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Log in with PayPal (sandbox), for publishers who want their own account. Shown only when
 * PAYPAL_LOGIN_ENABLED=true; a full-page navigation, since the route redirects to PayPal.
 */
export function PayPalLoginButton() {
  return (
    <div className="space-y-2">
      <a
        href="/api/auth/paypal/start"
        className={buttonVariants({
          variant: "outline",
          size: "lg",
          className: "h-11 w-full border-[1.5px] border-foreground bg-card text-base",
        })}
      >
        Log in with PayPal
      </a>
      <p className="text-center text-xs text-muted-foreground">
        Get your own publisher account. Payouts go to your verified PayPal sandbox email.
      </p>
    </div>
  );
}
