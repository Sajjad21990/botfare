"use client";

import type { DemoPersona } from "@botfare/contracts";
import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Judge tour: signs in as a demo persona (same endpoint as the sign-in page), then opens `href`.
 * One click per step, no password. `variant="link"` is a small text link for a second
 * destination under a step's main button.
 */
export function PersonaStepButton({
  persona,
  href,
  label,
  variant = "default",
  icon,
}: {
  persona: DemoPersona;
  href: string;
  label: string;
  variant?: "default" | "outline" | "link";
  icon?: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function go() {
    setPending(true);
    try {
      const response = await fetch("/api/session/persona", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      if (!response.ok) throw new Error(String(response.status));
      router.push(href);
      router.refresh();
    } catch {
      setPending(false);
      toast.error("Could not sign in. Is the database running?");
    }
  }

  if (variant === "link") {
    return (
      <Button
        variant="link"
        size="sm"
        className="text-foreground underline decoration-foreground/40 hover:decoration-foreground"
        disabled={pending}
        onClick={go}
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : icon}
        {pending ? "Signing in…" : label}
      </Button>
    );
  }

  return (
    <Button
      size="lg"
      variant={variant}
      className="h-11 w-full text-base"
      disabled={pending}
      onClick={go}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {pending ? "Signing in…" : label}
      {pending ? null : <ArrowRight aria-hidden data-icon="inline-end" />}
    </Button>
  );
}
