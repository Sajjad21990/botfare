import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* VerifySection imports through the "@/" alias, which the unit project does not resolve, so these
   checks read the sources the way landing-links does. */
const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");
const section = src("components/landing/verify-section.tsx");

describe("homepage receipts section", () => {
  it("is the #receipts anchor right after How it works", () => {
    expect(section).toMatch(/<section id="receipts" aria-labelledby="receipts-title"/);
    expect(section).toContain("styles.anchor");
    expect(src("app/page.tsx")).toMatch(/<HowSteps \/>\s*<VerifySection \/>/);
    expect(src("components/landing/site-header.tsx")).toContain('href="/#receipts"');
  });

  it("links to /verify once, in a new tab", () => {
    expect(section).toMatch(/<NewTabLink\s+href="\/verify"/);
    expect(section).toContain("Check a real receipt");
    expect(section).not.toMatch(/<a\s|<Link\s/);
    expect(src("components/landing/paypal-math.tsx")).not.toContain("/verify");
  });

  it("keeps the receipt drawing decorative", () => {
    expect(section).toMatch(
      /<div\s+aria-hidden\s+className=\{`\$\{styles\.printed\}[^`]*bg-ticket/,
    );
  });
});
