"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";
import styles from "./landing.module.css";

/**
 * A ticket with two real half-circle cut-outs on its tear line. The notches are holes in a CSS
 * mask, so the page shows through them, and the ink outline and hard shadow (drop-shadow filters on
 * the wrapper) follow the cut shape: no painted circles to line up. The tear line is the child
 * marked data-perforation; its centre sets --notch-y (the stylesheet has a close default for the
 * first paint).
 */
export function NotchedTicket({ children }: { children: ReactNode }) {
  const ticket = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ticket.current;
    const perforation = el?.querySelector<HTMLElement>("[data-perforation]");
    if (!el || !perforation) return;
    const place = () =>
      el.style.setProperty(
        "--notch-y",
        `${perforation.offsetTop + perforation.offsetHeight / 2}px`,
      );
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.notchedOutline}>
      <div ref={ticket} className={`${styles.notched} relative`}>
        {children}
      </div>
    </div>
  );
}
