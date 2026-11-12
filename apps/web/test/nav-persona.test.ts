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

  it("wraps the nav instead of scrolling it sideways", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain("flex min-w-0 flex-wrap");
    expect(nav).not.toContain("overflow-x-auto");
    expect(nav).not.toContain("flex-nowrap");
  });

  it("keeps the nav in view: its own row in a header that sticks to the top from sm up", () => {
    const layout = src("app/(app)/layout.tsx");
    expect(layout).toMatch(
      /<header className="[^"]*\bz-40\b[^"]*bg-background[^"]*sm:sticky sm:top-0/,
    );
    expect(layout).toMatch(/border-t border-dashed[^"]*">\s*<NavLinks/);
  });

  it("marks the current page with a filled ticket-yellow pill and labels each group on desktop", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain("text-[0.95rem] font-medium");
    expect(nav).toMatch(
      /active\s*\?\s*"[^"]*border-brand-foreground bg-brand text-brand-foreground/,
    );
    expect(nav).toContain('short: "Agent owner"');
    expect(nav).toContain('short: "Website owner"');
    expect(nav).toMatch(/hidden [^"]*uppercase lg:inline"/);
  });

  it("links Verify a receipt after both groups, without switching persona", () => {
    const nav = src("components/app/nav-links.tsx");
    expect(nav).toContain("<ShieldCheck");
    const verify = nav.indexOf('href="/verify"');
    expect(verify).toBeGreaterThan(nav.indexOf("GROUPS.map("));
    // A plain Link: no onClick, so no POST to /api/session/persona.
    const tag = nav.slice(nav.lastIndexOf("<Link", verify), nav.indexOf(">", verify));
    expect(tag).not.toContain("onClick");
    expect(nav.slice(verify)).toContain("Verify a receipt");
  });

  it("links Verify in the landing header before Sign in, from sm up", () => {
    const header = src("components/landing/site-header.tsx");
    expect(header).toMatch(/<Link href="\/verify" className=\{fromSm\}>\s*Verify\s*<\/Link>/);
    expect(header.indexOf('href="/verify"')).toBeLessThan(header.indexOf('href="/signin"'));
    expect(header).toContain("Try it in 2 minutes");
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
