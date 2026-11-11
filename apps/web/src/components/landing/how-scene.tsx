"use client";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { BotFareMark } from "../brand/bot-fare-mark";
import { FareAdvisorMark } from "../brand/fare-advisor-mark";
import { FareCourtMark } from "../brand/fare-court-mark";
import styles from "./how-scene.module.css";
import landing from "./landing.module.css";

/** The four actors, left to right on a wide screen and top to bottom on a phone. */
export const ACTORS = ["agent", "site", "botfare", "paypal"] as const;
export type ActorId = (typeof ACTORS)[number];

/** Something that travels between two actors, or pops up at one. */
export interface SceneMove {
  /** A few words: what is sent or what happened. */
  label: ReactNode;
  /** Where it ends up. */
  to: ActorId;
  /** Where it starts. Without it, the label pops up at `to`. */
  from?: ActorId;
  /** An actor it passes through, pausing there (a payment goes through the site to BotFare). */
  via?: ActorId;
  /** Its lane: 0, 1 or 2, so labels that meet at one actor do not overlap. */
  row: 0 | 1 | 2;
  tone?: "plain" | "yellow" | "ink" | "green" | "red";
  mono?: boolean;
  /** The other branch (Fare Court's refund when a page was not as promised): a dashed edge. */
  ghost?: boolean;
  /** When it starts, in ms after the step opens. */
  delay?: number;
}

export interface SceneStep {
  /** One word on the stepper. */
  label: string;
  /** The step in one line: ten words at most. */
  caption: string;
  /** One short line under the caption. */
  note?: string;
  /** The actors that take part; the others fade back. */
  active: readonly ActorId[];
  /** Which part of BotFare acts in this step, shown on its face. */
  botfareAs?: "court" | "advisor";
  moves: readonly SceneMove[];
  /** The exact facts, under Show the details. */
  detail: ReactNode;
}

/** A label flying from one actor to the next. */
export const FLY_MS = 900;
/** A label flying through a middle actor, with a pause there. */
export const HOP_MS = 1800;
/** A label popping up at an actor. */
export const POP_MS = 450;
/** When a move starts if it gives no delay: just after the step opens. */
export const START_DELAY_MS = 150;
/** How long Play holds a step after its last move lands, to read the caption. */
export const READ_MS = 1500;

/** The visitor's own input, anywhere on the page, that stops Play. */
const INTERRUPTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** Trackpad momentum keeps sending wheel events for a moment after a scroll; Play ignores those. */
const WHEEL_GRACE_MS = 800;
/** A first view this soon after load already saw step 1 animate, so it is not replayed. */
const LOAD_GRACE_MS = 600;

function moveKind(move: SceneMove): "pop" | "hop" | "fly" {
  if (move.from === undefined) return "pop";
  return move.via === undefined ? "fly" : "hop";
}

function moveMs(move: SceneMove): number {
  const kind = moveKind(move);
  return kind === "pop" ? POP_MS : kind === "hop" ? HOP_MS : FLY_MS;
}

/** When a move has landed, in ms after its step opens. */
export function moveEndMs(move: SceneMove): number {
  return (move.delay ?? START_DELAY_MS) + moveMs(move);
}

/** When a step's last move has landed. */
export function stepEndMs(step: SceneStep): number {
  return Math.max(0, ...step.moves.map(moveEndMs));
}

/** How long Play stays on a step before the next one. */
export function stepHoldMs(step: SceneStep): number {
  return stepEndMs(step) + READ_MS;
}

/** Play from step 1 until the last step's last move lands. */
export function playDurationMs(steps: readonly SceneStep[]): number {
  return steps.reduce(
    (total, step, index) =>
      total + (index === steps.length - 1 ? stepEndMs(step) : stepHoldMs(step)),
    0,
  );
}

function AgentFace() {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      fill="none"
      stroke="#1c1a16"
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M32 13V6" />
      <circle cx={32} cy={5} r={3.2} fill="#1c1a16" stroke="none" />
      <rect x={11} y={13} width={42} height={34} rx={10} fill="#ffffff" />
      <circle cx={24} cy={29} r={3.8} fill="#1c1a16" stroke="none" />
      <circle cx={40} cy={29} r={3.8} fill="#1c1a16" stroke="none" />
      <path d="M25 38q7 5 14 0" />
      <path d="M20 47v8M44 47v8" />
    </svg>
  );
}

/** The demo site's own mark: a pot with a sprig of saffron (apps/demo favicon). */
function SiteFace() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <path
        d="M20.5 2.5 24 12"
        fill="none"
        stroke="#e3a21a"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <path
        d="M14 4.5c-1.2 1.6.8 2.8-.4 4.6M10 5.5c-1.2 1.6.8 2.8-.4 4.6"
        fill="none"
        stroke="#e3a21a"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <rect x={4} y={12} width={24} height={3.2} rx={1.6} fill="#8c3c1d" />
      <path d="M6 15.2h20V21a7 7 0 0 1-7 7h-6a7 7 0 0 1-7-7z" fill="#b0502a" />
      <path
        d="M6 17.5H3.2M26 17.5h2.8"
        fill="none"
        stroke="#8c3c1d"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function botfareCast(as: SceneStep["botfareAs"]): { name: string; role: string; face: ReactNode } {
  if (as === "court") {
    return { name: "Fare Court", role: "part of BotFare", face: <FareCourtMark /> };
  }
  if (as === "advisor") {
    return { name: "Fare Advisor", role: "part of BotFare", face: <FareAdvisorMark /> };
  }
  return { name: "BotFare", role: "checks and settles", face: <BotFareMark /> };
}

/** CSS custom properties for inline styles. */
function vars(values: Record<string, string | number>): CSSProperties {
  return values as CSSProperties;
}

/**
 * How it works as one animated scene: the AI agent, the website, BotFare and PayPal, with what
 * passes between them in each of the steps. A stepper on top (click a stop, or arrow keys on it),
 * ← and →, and Play, which runs every step in turn and stops at the end or as soon as the visitor
 * clicks, taps, types or scrolls anywhere else. Each step has a one-line caption; Show the details
 * opens the step's exact facts. Nothing advances on its own; step 1 replays once when the scene
 * first comes into view. The scene itself is drawn for the eye (aria-hidden): the caption, note
 * and details say the same in words. With reduced motion, labels appear in place instead of flying.
 */
export function HowScene({ steps, siteName }: { steps: readonly SceneStep[]; siteName: string }) {
  const baseId = useId();
  const [step, setStep] = useState(0);
  /** Bumped to replay the current step's moves from the start. */
  const [run, setRun] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [details, setDetails] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const last = steps.length - 1;
  const current = steps[step] ?? steps[0];
  const tabId = (index: number) => `${baseId}-step-${index + 1}`;
  const panelId = `${baseId}-caption`;
  const detailsId = `${baseId}-details`;

  function show(index: number, announce: boolean) {
    const next = Math.max(0, Math.min(last, index));
    setStep(next);
    setRun((value) => value + 1);
    if (announce) {
      setAnnouncement(`Step ${next + 1} of ${steps.length}. ${steps[next]?.caption ?? ""}`);
    }
  }

  // Play: hold each step until its moves have landed and the caption has been read, then open the
  // next; stop once the last step's moves have landed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts the hold whenever a step (re)opens
  useEffect(() => {
    if (!playing || !current) return;
    const atEnd = step >= last;
    const timer = window.setTimeout(
      () => {
        if (atEnd) setPlaying(false);
        else show(step + 1, true);
      },
      atEnd ? stepEndMs(current) : stepHoldMs(current),
    );
    return () => window.clearTimeout(timer);
  }, [playing, step, run]);

  // While Play runs, any click, tap, key press or wheel turn on the page other than on Play itself
  // stops it. Wheel events in the first moment are the tail of the scroll that brought the visitor.
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

  // Replay step 1 once when the scene first comes into view, so its move is seen, not missed while
  // the visitor was still at the top of the page.
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const mountedAt = performance.now();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (performance.now() - mountedAt > LOAD_GRACE_MS) setRun((value) => value + 1);
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    show(step >= last ? 0 : step, true);
    setPlaying(true);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target =
      event.key === "ArrowRight"
        ? Math.min(index + 1, last)
        : event.key === "ArrowLeft"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    setPlaying(false);
    show(target, false);
    tabs.current[target]?.focus();
  }

  if (!current) return null;
  const active = new Set<ActorId>(current.active);
  const cast: Record<ActorId, { name: string; role: string; face: ReactNode }> = {
    agent: { name: "AI agent", role: "reads and pays", face: <AgentFace /> },
    site: { name: siteName, role: "the website", face: <SiteFace /> },
    botfare: botfareCast(current.botfareAs),
    paypal: {
      name: "PayPal",
      role: "top-ups and payouts",
      face: <span className={styles.wordmark}>PayPal</span>,
    },
  };
  const atEnd = step >= last;

  return (
    <div className={styles.scene}>
      <div
        role="tablist"
        aria-label="Steps"
        className={styles.stops}
        style={vars({ "--count": steps.length, "--progress": last > 0 ? step / last : 0 })}
      >
        <span aria-hidden className={styles.track}>
          <span className={styles.fill} />
        </span>
        {steps.map((item, index) => (
          <button
            key={item.label}
            ref={(button) => {
              tabs.current[index] = button;
            }}
            id={tabId(index)}
            type="button"
            role="tab"
            aria-selected={index === step}
            aria-controls={panelId}
            tabIndex={index === step ? 0 : -1}
            data-state={index < step ? "done" : index === step ? "on" : "next"}
            onClick={() => {
              setPlaying(false);
              show(index, false);
            }}
            onKeyDown={(event) => onTabKey(event, index)}
            className={styles.stop}
          >
            <span className={styles.dot}>
              <span className="sr-only">Step </span>
              {index + 1}
            </span>
            <span className={styles.stopLabel}>{item.label}</span>
          </button>
        ))}
      </div>

      <div ref={stage} aria-hidden className={styles.stage}>
        <div className={styles.actors}>
          {ACTORS.map((id) => (
            <div key={id} className={styles.actor} data-active={active.has(id)}>
              <div
                key={id === "botfare" ? (current.botfareAs ?? "botfare") : id}
                className={styles.face}
              >
                {cast[id].face}
              </div>
              <p className={styles.name}>{cast[id].name}</p>
              <p className={styles.role}>{cast[id].role}</p>
            </div>
          ))}
        </div>
        <div className={styles.lane}>
          {ACTORS.map((id, index) => (
            <span key={id} className={styles.lifeline} style={vars({ "--i": index })} />
          ))}
          <div key={`${step}-${run}`} className={styles.moves}>
            {current.moves.map((move, index) => {
              const to = ACTORS.indexOf(move.to);
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: a step's moves never reorder
                  key={index}
                  className={styles.rider}
                  data-kind={moveKind(move)}
                  style={vars({
                    "--from": move.from ? ACTORS.indexOf(move.from) : to,
                    "--via": move.via ? ACTORS.indexOf(move.via) : to,
                    "--to": to,
                    "--row": move.row,
                    "--delay": `${move.delay ?? START_DELAY_MS}ms`,
                    "--dur": `${moveMs(move)}ms`,
                  })}
                >
                  <span
                    className={styles.token}
                    data-tone={move.tone ?? "plain"}
                    data-mono={move.mono === true}
                    data-ghost={move.ghost === true}
                  >
                    {move.label}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(step)}
        className="mt-6 text-center sm:mt-7"
      >
        <div key={step} className={styles.captionIn}>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Step {step + 1} of {steps.length} · {current.label}
          </p>
          <p className="mx-auto mt-1.5 max-w-2xl font-heading text-xl leading-snug font-extrabold text-balance sm:text-2xl">
            {current.caption}
          </p>
          {current.note ? (
            <p className="mx-auto mt-1.5 max-w-xl leading-relaxed text-pretty text-muted-foreground">
              {current.note}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous step"
            aria-disabled={step === 0}
            onClick={() => {
              setPlaying(false);
              if (step > 0) show(step - 1, true);
            }}
            className={`${landing.focusRing} ${styles.iconButton}`}
          >
            <ChevronLeftIcon aria-hidden className="size-5" />
          </button>
          <button
            ref={playButton}
            type="button"
            onClick={togglePlay}
            className={`${landing.focusRing} inline-flex h-10 min-w-[7.5rem] items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-semibold text-brand`}
          >
            {playing ? (
              <PauseIcon aria-hidden className="size-4 fill-current" />
            ) : atEnd ? (
              <RotateCcwIcon aria-hidden className="size-4" />
            ) : (
              <PlayIcon aria-hidden className="size-4 fill-current" />
            )}
            {playing ? "Pause" : atEnd ? "Play again" : "Play"}
          </button>
          <button
            type="button"
            aria-label="Next step"
            aria-disabled={atEnd}
            onClick={() => {
              setPlaying(false);
              if (!atEnd) show(step + 1, true);
            }}
            className={`${landing.focusRing} ${styles.iconButton}`}
          >
            <ChevronRightIcon aria-hidden className="size-5" />
          </button>
        </div>
        <button
          type="button"
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={() => setDetails(!details)}
          className={`${landing.focusRing} inline-flex h-10 items-center gap-1.5 rounded-lg border-[1.5px] border-foreground bg-card px-4 text-sm font-semibold`}
        >
          {details ? "Hide the details" : "Show the details"}
          <ChevronDownIcon
            aria-hidden
            className={`size-4 transition-transform duration-300 ease-out motion-reduce:transition-none ${details ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <section
        id={detailsId}
        aria-label={`Details of step ${step + 1}`}
        data-open={details}
        inert={!details}
        className={landing.panel}
      >
        <div className={landing.panelInner}>
          <div className="pt-6">
            <div
              key={step}
              className={`${styles.captionIn} mx-auto max-w-2xl rounded-xl border-[1.5px] border-foreground bg-card p-4 text-left sm:p-5`}
            >
              {current.detail}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
