"use client";

import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Eased wheel and trackpad scrolling on the public pages, with same-page links (/#how) gliding to
 * their section. The dashboards keep native scrolling: their tables, dialogs and the AG Studio
 * canvas scroll inside themselves. Lenis follows prefers-reduced-motion (no smoothing at all).
 */
const SMOOTH_PATHS = new Set(["/", "/judge", "/signin", "/verify", "/privacy", "/terms"]);

export function SmoothScroll() {
  const pathname = usePathname();
  const enabled = SMOOTH_PATHS.has(pathname);

  useEffect(() => {
    if (!enabled) return;
    const lenis = new Lenis({
      autoRaf: true,
      lerp: 0.12,
      anchors: { offset: -16 },
      allowNestedScroll: true,
    });
    return () => lenis.destroy();
  }, [enabled]);

  return null;
}
