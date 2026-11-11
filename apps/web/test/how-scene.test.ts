import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACTORS,
  HowScene,
  moveEndMs,
  playDurationMs,
  type SceneStep,
  stepEndMs,
  stepHoldMs,
} from "../src/components/landing/how-scene";
import { HOW_STEPS } from "../src/components/landing/how-steps";

function render(steps: readonly SceneStep[] = HOW_STEPS): string {
  return renderToStaticMarkup(createElement(HowScene, { steps, siteName: "Saffron & Salt" }));
}

const words = (text: string) => text.trim().split(/\s+/).length;

describe("How it works scene (server HTML)", () => {
  it("shows the stepper with step 1 selected, and only step 1's caption", () => {
    const html = render();
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(([tag]) => tag);
    expect(tabs).toHaveLength(HOW_STEPS.length);
    expect(tabs.map((tag) => tag.includes('aria-selected="true"'))).toEqual([
      true,
      ...Array<boolean>(HOW_STEPS.length - 1).fill(false),
    ]);
    // Roving focus: only the selected stop is in the tab order.
    expect(tabs.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1);

    expect(html).toContain(HOW_STEPS[0]?.caption);
    for (const step of HOW_STEPS.slice(1)) expect(html).not.toContain(step.caption);
  });

  it("ties every stop to the caption panel, labelled by the selected stop", () => {
    const html = render();
    const controls = new Set([...html.matchAll(/aria-controls="([^"]+)"/g)].map(([, id]) => id));
    for (const id of controls) expect(html).toContain(`id="${id}"`);
    const panel = html.match(/<div id="([^"]+)" role="tabpanel" aria-labelledby="([^"]+)"/);
    expect(panel).not.toBeNull();
    expect(html).toMatch(new RegExp(`id="${panel?.[2]}"[^>]*role="tab"[^>]*aria-selected="true"`));
  });

  it("draws the scene for the eye only and keeps the details shut and inert", () => {
    const html = render();
    expect(html).toMatch(/<div aria-hidden="true" class="[^"]*stage/);
    const details = html.match(/<section id="[^"]+"([^>]*)>/);
    expect(details?.[1]).toContain('data-open="false"');
    expect(details?.[1]).toMatch(/\binert\b/);
    expect(html).toContain("Show the details");
    expect(html).toMatch(/>Play<\/button>/);
    expect(html).not.toContain("Pause");
  });

  it("names the four actors, with the site's own name", () => {
    const html = render();
    for (const name of ["AI agent", "Saffron &amp; Salt", "BotFare", "PayPal"]) {
      expect(html).toContain(name);
    }
  });
});

describe("How it works content", () => {
  it("has eight steps with one-word stops and captions of ten words at most", () => {
    expect(HOW_STEPS).toHaveLength(8);
    for (const step of HOW_STEPS) {
      expect(words(step.label)).toBe(1);
      expect(words(step.caption), step.caption).toBeLessThanOrEqual(10);
      if (step.note) expect(words(step.note), step.note).toBeLessThanOrEqual(14);
    }
    expect(new Set(HOW_STEPS.map((step) => step.label)).size).toBe(HOW_STEPS.length);
  });

  it("moves only between the four actors, and never from an actor to itself", () => {
    for (const step of HOW_STEPS) {
      expect(step.moves.length).toBeGreaterThan(0);
      expect(step.moves.length).toBeLessThanOrEqual(3);
      for (const move of step.moves) {
        expect(ACTORS).toContain(move.to);
        if (move.from) expect(move.from).not.toBe(move.to);
        if (move.via) {
          expect(move.from).toBeDefined();
          expect([move.from, move.to]).not.toContain(move.via);
        }
        // Everyone who sends, receives or passes something on takes part in the step.
        for (const actor of [move.from, move.via, move.to]) {
          if (actor) expect(step.active, `${step.label}: ${actor}`).toContain(actor);
        }
      }
    }
  });

  it("never lands two labels in the same place", () => {
    for (const step of HOW_STEPS) {
      const spots = step.moves.map((move) => `${move.to}/${move.row}`);
      expect(new Set(spots).size, step.label).toBe(spots.length);
    }
  });

  it("plays the whole story in about 25 seconds", () => {
    const total = playDurationMs(HOW_STEPS);
    expect(total).toBeGreaterThanOrEqual(20_000);
    expect(total).toBeLessThanOrEqual(30_000);
    for (const step of HOW_STEPS) {
      expect(stepHoldMs(step)).toBeGreaterThan(stepEndMs(step));
      // Each step's moves land within about four seconds, so Play never feels stuck.
      expect(stepEndMs(step), step.label).toBeLessThanOrEqual(4_500);
    }
  });

  it("times a move from its kind: fly, hop through a middle actor, or pop up", () => {
    expect(moveEndMs({ label: "a", to: "site", row: 0 })).toBe(150 + 450);
    expect(moveEndMs({ label: "a", from: "agent", to: "site", row: 0, delay: 0 })).toBe(900);
    expect(
      moveEndMs({ label: "a", from: "agent", via: "site", to: "botfare", row: 0, delay: 100 }),
    ).toBe(1900);
  });
});
