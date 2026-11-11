"use client";

import type { DemoPersona } from "@botfare/contracts";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { NewTabHint } from "@/components/app/external-link";
import { Button } from "@/components/ui/button";

/**
 * Opens a blank tab for `href` during the click, while the browser still counts it as a user
 * gesture, so popup blockers allow it. Returns null when the popup was blocked.
 */
function openPendingTab(): Window | null {
  const tab = window.open("about:blank", "_blank");
  if (!tab) return null;
  tab.opener = null;
  try {
    tab.document.title = "Signing in · BotFare";
    tab.document.body.textContent = "Signing in to BotFare…";
  } catch {
    // The placeholder text is optional; the tab still navigates once sign-in finishes.
  }
  return tab;
}

/**
 * Judge tour: signs in as a demo persona (same endpoint as the sign-in page), then opens `href`
 * in a new tab so the tour stays open. If the browser blocks the new tab, it opens `href` here
 * instead. One click per step, no password. `variant="link"` is a small text link for a second
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
    const tab = openPendingTab();
    setPending(true);
    try {
      const response = await fetch("/api/session/persona", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      if (!response.ok) throw new Error(String(response.status));
      if (tab) {
        if (!tab.closed) tab.location.href = new URL(href, window.location.origin).href;
        setPending(false);
        return;
      }
      router.push(href);
      router.refresh();
    } catch {
      tab?.close();
      setPending(false);
      toast.error("Could not sign in. Try again in a moment.");
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
        {pending ? null : <NewTabHint />}
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
      {pending ? null : <NewTabHint />}
      {pending ? null : <ArrowUpRight aria-hidden data-icon="inline-end" />}
    </Button>
  );
}
