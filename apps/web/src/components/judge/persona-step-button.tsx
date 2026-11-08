"use client";

import type { DemoPersona } from "@botfare/contracts";
import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Judge tour: signs in as a demo persona (same endpoint as the sign-in page), then opens `href`.
 * One click per step, no password.
 */
export function PersonaStepButton({
  persona,
  href,
  label,
  variant = "default",
}: {
  persona: DemoPersona;
  href: string;
  label: string;
  variant?: "default" | "outline";
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

  return (
    <Button size="lg" variant={variant} className="w-full" disabled={pending} onClick={go}>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {pending ? "Signing in…" : label}
      {pending ? null : <ArrowRight aria-hidden data-icon="inline-end" />}
    </Button>
  );
}
