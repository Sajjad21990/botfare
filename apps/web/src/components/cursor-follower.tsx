"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { SMOOTH_PATHS } from "./smooth-scroll";

/** How far the follower closes the gap to the pointer each frame (0 to 1): lower trails more. */
const FOLLOW = 0.2;

/** What counts as something to click, for the follower to swell over. */
const INTERACTIVE = "a, button, [role='button'], input, textarea, select, summary, label";

/**
 * A ticket-yellow highlighter that trails the pointer on the public pages: it multiplies over the
 * page like a marker pen, swells over links and buttons, and presses in on click. The real cursor
 * stays, so clicks are exactly where the visitor points. Only for a mouse or trackpad and only
 * without prefers-reduced-motion; the frame loop sleeps once the follower catches up.
 */
export function CursorFollower() {
  const pathname = usePathname();
  const enabled = SMOOTH_PATHS.has(pathname);
  const dot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dot.current;
    if (!enabled || !el) return;
    const fine = window.matchMedia("(pointer: fine)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!fine.matches || reduced.matches) return;

    let x = -100;
    let y = -100;
    let targetX = -100;
    let targetY = -100;
    let frame = 0;
    let shown = false;

    const draw = () => {
      x += (targetX - x) * FOLLOW;
      y += (targetY - y) * FOLLOW;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      frame = Math.abs(targetX - x) + Math.abs(targetY - y) > 0.3 ? requestAnimationFrame(draw) : 0;
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      targetX = event.clientX;
      targetY = event.clientY;
      if (!shown) {
        // Appear where the pointer is, not sliding in from a corner.
        x = targetX;
        y = targetY;
        shown = true;
        el.dataset.shown = "true";
      }
      const over = (event.target as Element | null)?.closest?.(INTERACTIVE);
      el.dataset.hover = over ? "true" : "false";
      wake();
    };
    const leave = () => {
      shown = false;
      el.dataset.shown = "false";
    };
    const down = () => {
      el.dataset.down = "true";
    };
    const up = () => {
      el.dataset.down = "false";
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerup", up, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      document.documentElement.removeEventListener("pointerleave", leave);
      el.dataset.shown = "false";
    };
  }, [enabled]);

  if (!enabled) return null;
  return <div ref={dot} aria-hidden className="cursor-follower" data-shown="false" />;
}
