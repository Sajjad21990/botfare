import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FlowStep, HowFlow } from "../src/components/landing/how-flow";

const steps: FlowStep[] = Array.from({ length: 8 }, (_, i) => ({
  actor: i % 2 ? "Agent" : "Site",
  title: `Step title ${i + 1}`,
  detail: createElement("p", null, `Detail ${i + 1}`),
}));

function render(): string {
  return renderToStaticMarkup(
    createElement(HowFlow, { steps, header: createElement("h2", null, "How it works") }),
  );
}

describe("How it works flow (server HTML)", () => {
  it("shows every step title and opens only step 1", () => {
    const html = render();
    for (const step of steps) expect(html).toContain(step.title);

    const buttons = [...html.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>/g)];
    expect(buttons.map(([, expanded]) => expanded)).toEqual([
      "true",
      ...Array<string>(7).fill("false"),
    ]);

    // Every panel is in the HTML; all but the first are collapsed and inert (out of the tab
    // order and the accessibility tree) until opened.
    for (let i = 1; i <= 8; i++) expect(html).toContain(`Detail ${i}`);
    const panels = [...html.matchAll(/<div id="([^"]+-panel-\d+)"([^>]*)>/g)];
    expect(panels).toHaveLength(8);
    expect(panels.map(([, , attrs]) => attrs.includes('data-open="true"'))).toEqual([
      true,
      ...Array<boolean>(7).fill(false),
    ]);
    expect(panels.map(([, , attrs]) => /\binert\b/.test(attrs))).toEqual([
      false,
      ...Array<boolean>(7).fill(true),
    ]);
  });

  it("ties each step button to its panel", () => {
    const html = render();
    const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(([, id]) => id);
    expect(controls).toHaveLength(8);
    for (const id of controls) expect(html).toContain(`id="${id}"`);
  });

  it("renders the Play and Show all controls, nothing playing", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>.*?Play<\/button>/);
    expect(html).toContain("Show all steps");
    expect(html).not.toContain("Stop");
  });
});
