"use client";

import { Scale } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { api } from "./api";
import type { PublisherDisputes } from "./disputes-types";

const REFRESH_MS = 30_000;

/** The publisher header's "Disputes" button, with how many disputes wait for review. */
export function DisputesLink() {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const data = await api<PublisherDisputes>("GET", "/api/publisher/disputes");
        if (!cancelled) setPending(data.pendingCount);
      } catch {
        // The badge is a hint; the Disputes page shows errors.
      }
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  return (
    <Link
      href="/publisher/disputes"
      className={buttonVariants({ variant: "outline" })}
      aria-label={pending > 0 ? `Disputes, ${pending} to review` : "Disputes"}
    >
      <Scale />
      Disputes
      {pending > 0 && (
        <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground tabular-nums">
          {pending}
        </span>
      )}
    </Link>
  );
}
