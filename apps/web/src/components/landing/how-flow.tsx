"use client";

import { ChevronDownIcon, PlayIcon, SquareIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { glideTo } from "../smooth-scroll";
import styles from "./landing.module.css";

export interface FlowStep {
  /** Who acts in this step, printed small above the title. */
  actor: string;
  /** The step in one line. Always visible. */
  title: string;
  /** The panel the step opens: a small visual and a sentence or two. */
  detail: ReactNode;
}

/** How long Play keeps each step open before it opens the next. */
export const PLAY_STEP_MS = 2500;

/** The visitor's own input, anywhere on the page, that stops Play. Play's own scrolling is none. */
const INTERRUPTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Trackpad momentum keeps sending wheel events for a moment after a scroll; Play ignores those. */
const WHEEL_GRACE_MS = 800;

/** A panel's open or close animation (landing.module.css .panel); the page settles after it. */
const PANEL_MS = 340;

/** Where a step comes to rest when the page glides to it: clear of the top edge. */
const REST_OFFSET_PX = 96;

/**
 * The How it works steps on a vertical rail. Every title is always visible; a step's button opens
 * its panel. One panel is open at a time (step 1 on load, so the server HTML shows it too), or all
 * of them with the Show all toggle. Play opens the steps in turn and stops at the last one or as
 * soon as the visitor clicks, taps, types or scrolls anywhere on the page. Panels glide open and
 * shut, the rail fills in up to the open step, and when an opened step ends up out of view the page
 * glides to it through the site's smooth scrolling. With reduced motion everything changes at once;
 * nothing ever starts on its own.
 */
export function HowFlow({ header, steps }: { header: ReactNode; steps: FlowStep[] }) {
  const baseId = useId();
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [playing, setPlaying] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const playButton = useRef<HTMLButtonElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  /** The step just opened (by Play or a click), to bring into view once its panel has settled. */
  const follow = useRef<number | null>(null);
  /** The rail fills in up to the open step; with every step open it stays empty. */
  const current = showAll || open.size === 0 ? -1 : Math.min(...open);

  useEffect(() => {
    if (!playing) return;
    let step = 0;
    const show = (index: number) => {
      follow.current = index;
      setShowAll(false);
      setOpen(new Set([index]));
      setAnnouncement(`Step ${index + 1} of ${steps.length}. ${steps[index]?.title ?? ""}`);
    };
    show(step);
    const timer = window.setInterval(() => {
      step += 1;
      show(step);
      if (step >= steps.length - 1) setPlaying(false);
    }, PLAY_STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing, steps]);

  // Once the panels have finished moving, glide to the step just opened if it is out of view:
  // above the top edge after the panel above it closed, or below the fold during Play.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each change to the open steps
  useEffect(() => {
    const index = follow.current;
    follow.current = null;
    if (index === null) return;
    const timer = window.setTimeout(() => {
      const item = items.current[index];
      if (!item) return;
      const box = item.getBoundingClientRect();
      const fits = box.height <= window.innerHeight - REST_OFFSET_PX;
      const hidden = box.top < 16 || (fits && box.bottom > window.innerHeight - 16);
      if (hidden) glideTo(item, REST_OFFSET_PX);
    }, PANEL_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // While Play runs, any click, tap, key press or wheel turn on the page, other than on Play
  // itself, stops it, so Play never scrolls the page back while the visitor is reading elsewhere.
  // Wheel events in the first moment are the tail of the scroll that brought the visitor here.
  useEffect(() => {
    if (!playing) return;
    const startedAt = performance.now();
    const stop = (event: Event) => {
      if (event.type === "wheel" && performance.now() - startedAt < WHEEL_GRACE_MS) return;
      if (!playButton.current?.contains(event.target as Node)) setPlaying(false);
    };
    for (const type of INTERRUPTS) {
      window.addEventListener(type, stop, { capture: true, passive: true });
    }
    return () => {
      for (const type of INTERRUPTS) window.removeEventListener(type, stop, { capture: true });
    };
  }, [playing]);

  function toggleStep(index: number) {
    if (!open.has(index)) follow.current = index;
    setOpen((current) => {
      if (!showAll) return current.has(index) ? new Set() : new Set([index]);
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleShowAll() {
    if (showAll) {
      // Back to one at a time: keep the first open step, or step 1.
      setOpen((current) => new Set([current.size > 0 ? Math.min(...current) : 0]));
    } else {
      setOpen(new Set(steps.map((_, index) => index)));
    }
    setShowAll(!showAll);
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = steps.length - 1;
    const target =
      event.key === "ArrowDown"
        ? Math.min(index + 1, last)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    buttons.current[target]?.focus();
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[17.5rem_minmax(0,1fr)] lg:gap-16">
      <div className="lg:sticky lg:top-8 lg:self-start">
        {header}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            ref={playButton}
            type="button"
            onClick={() => setPlaying(!playing)}
            className={`${styles.focusRing} inline-flex h-10 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-semibold text-brand`}
          >
            {playing ? (
              <SquareIcon aria-hidden className="size-3.5 fill-current" />
            ) : (
              <PlayIcon aria-hidden className="size-4 fill-current" />
            )}
            {playing ? "Stop" : "Play"}
          </button>
          <button
            type="button"
            onClick={toggleShowAll}
            className={`${styles.focusRing} inline-flex h-10 items-center rounded-lg border-[1.5px] border-foreground bg-card px-4 text-sm font-semibold`}
          >
            {showAll ? "Show one at a time" : "Show all steps"}
          </button>
        </div>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>

      <ol className="min-w-0">
        {steps.map((step, index) => {
          const isOpen = open.has(index);
          const buttonId = `${baseId}-step-${index + 1}`;
          const panelId = `${baseId}-panel-${index + 1}`;
          return (
            <li
              key={step.title}
              ref={(item) => {
                items.current[index] = item;
              }}
              className="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 pb-3 last:pb-0 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:gap-x-4"
            >
              {index < steps.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute top-7 -bottom-7 left-[1.125rem] -ml-px border-l-2 border-dashed border-foreground/45 sm:left-5"
                >
                  <span
                    className={`${styles.railFill} ${index < current ? styles.railFillOn : ""}`}
                  />
                </span>
              ) : null}
              <span
                aria-hidden
                className={`${styles.node} relative mt-2.5 grid size-9 place-items-center rounded-full border-[1.5px] border-foreground font-heading text-base font-extrabold sm:mt-2 sm:size-10 sm:text-lg ${
                  index < current
                    ? "bg-foreground text-brand"
                    : isOpen
                      ? `${styles.nodeOn} bg-brand`
                      : "bg-brand"
                }`}
              >
                {index + 1}
              </span>
              <div className={`${styles.stepCard} rounded-xl ${isOpen ? styles.stepCardOn : ""}`}>
                <h3 className="text-base">
                  <button
                    ref={(button) => {
                      buttons.current[index] = button;
                    }}
                    id={buttonId}
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggleStep(index)}
                    onKeyDown={(event) => moveFocus(event, index)}
                    className={`${styles.focusRing} flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left sm:px-4 ${isOpen ? "" : "hover:bg-muted/70"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                        {step.actor}
                      </span>
                      <span className="mt-0.5 block font-heading text-lg leading-snug font-bold sm:text-xl">
                        {step.title}
                      </span>
                    </span>
                    <ChevronDownIcon
                      aria-hidden
                      className={`mt-3 size-5 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                </h3>
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  data-open={isOpen}
                  inert={!isOpen}
                  className={styles.panel}
                >
                  <div className={styles.panelInner}>
                    <div className="px-3.5 pt-1 pb-5 sm:px-4">{step.detail}</div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
