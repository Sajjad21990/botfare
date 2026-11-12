import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* The layout and nav import through the "@/" alias, which the unit project does not resolve, so
   these checks read the sources the way landing-links does. */
const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

describe("signed-in nav for the demo personas", () => {
  it("shows the persona's role from sm up and hands it to the nav", () => {
    const layout = src("app/(app)/layout.tsx");
    expect(layout).toContain("DEMO_PERSONAS[persona].label");
    expect(layout).toContain("demoPersona={persona}");
    expect(layout).toContain("hidden max-w-48 truncate sm:inline");
  });

  it("switches persona on the other group's links, and only for a demo persona", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain('persona: "agentOwner"');
    expect(nav).toContain('persona: "publisher"');
    expect(nav).toContain('"/api/session/persona"');
    expect(nav).toMatch(/demoPersona !== undefined && demoPersona !== group\.persona/);
  });
});
