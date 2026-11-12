import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* The layout and nav import through the "@/" alias, which the unit project does not resolve, so
   these checks read the sources the way landing-links does. */
const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

describe("signed-in nav for the demo personas", () => {
  it("shows the persona's role on every width and hands it to the nav", () => {
    const layout = src("app/(app)/layout.tsx");
    expect(layout).toContain("DEMO_PERSONAS[persona].label");
    expect(layout).toContain("demoPersona={persona}");
    // Beside Sign out from sm up, under the Sandbox chip on a phone.
    expect(layout).toContain("hidden max-w-48 truncate sm:inline");
    expect(layout).toMatch(
      /text-muted-foreground sm:hidden">\s*\{DEMO_PERSONAS\[persona\]\.label\}/,
    );
  });

  it("wraps the nav on a phone instead of scrolling it sideways", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain("flex-wrap");
    expect(nav).toContain("gap-x-4 gap-y-1 sm:flex-nowrap");
    const layout = src("app/(app)/layout.tsx");
    expect(layout).not.toMatch(/order-last[^"]* h-11/);
  });

  it("switches persona on the other group's links, and only for a demo persona", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain('persona: "agentOwner"');
    expect(nav).toContain('persona: "publisher"');
    expect(nav).toContain('"/api/session/persona"');
    expect(nav).toMatch(/demoPersona !== undefined && demoPersona !== group\.persona/);
  });

  it("switches persona when the page belongs to the other role (Back, typed URL), once per page", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain("[pathname, demoPersona, router]");
    // Never for a real user, never for the persona's own pages, one POST per target persona.
    expect(nav).toMatch(/if \(!demoPersona\) return;/);
    expect(nav).toMatch(/owner === demoPersona/);
    expect(nav).toMatch(/switchedTo\.current === owner\) return;/);
    expect(nav).toMatch(/if \(response\.ok\) router\.refresh\(\)/);
    // A click sets the same guard, so the effect does not post again after the click navigates.
    expect(nav).toMatch(/switching\.current = true;\s*switchedTo\.current = persona;/);
  });
});
