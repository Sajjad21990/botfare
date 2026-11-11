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
export const SMOOTH_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/judge",
  "/signin",
  "/verify",
  "/privacy",
  "/terms",
]);

/** The page's Lenis while one runs, so components scroll through it instead of fighting it. */
let active: Lenis | null = null;

/**
 * Glides the page so `target` sits `offset` pixels below the top of the viewport: through Lenis on
 * the smooth pages, natively elsewhere, and instantly when the visitor prefers reduced motion.
 */
export function glideTo(target: HTMLElement, offset = 0): void {
  if (active) {
    active.scrollTo(target, { offset: -offset, duration: 0.9 });
    return;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = target.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
}

export function SmoothScroll() {
  const pathname = usePathname();
  const enabled = SMOOTH_PATHS.has(pathname);

  useEffect(() => {
    if (!enabled) return;
    const lenis = new Lenis({
      autoRaf: true,
      // 0.25 keeps the glide but follows the wheel closely; lower values felt laggy.
      lerp: 0.25,
      anchors: { offset: -16 },
      allowNestedScroll: true,
    });
    active = lenis;
    return () => {
      if (active === lenis) active = null;
      lenis.destroy();
    };
  }, [enabled]);

  return null;
}
