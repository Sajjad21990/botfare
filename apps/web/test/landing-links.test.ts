import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NEW_TAB_HINT } from "../src/components/landing/links";
import { NewTabLink } from "../src/components/landing/new-tab-link";

const landingDir = join(import.meta.dirname, "../src/components/landing");
const landingSources = readdirSync(landingDir)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => ({ name, source: readFileSync(join(landingDir, name), "utf8") }));

describe("landing links", () => {
  it("NewTabLink opens a new tab and says so", () => {
    const html = renderToStaticMarkup(
      createElement(NewTabLink, { href: "https://example.com" }, "See the code"),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(`<span class="sr-only">${NEW_TAB_HINT}</span>`);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);

    const plain = renderToStaticMarkup(
      createElement(NewTabLink, { href: "/verify", icon: false }, "Verify"),
    );
    expect(plain).toContain('target="_blank"');
    expect(plain).not.toContain("<svg");
  });

  it("uses plain anchors only for same-page sections and Link only for in-app pages", () => {
    for (const { name, source } of landingSources) {
      for (const [, href] of source.matchAll(/<a\s[^>]*?href=(\{[^}]*\}|"[^"]*")/g)) {
        expect(href, `${name}: <a href=${href}>`).toMatch(/^"\/#[a-z-]+"$/);
      }
      for (const [, href] of source.matchAll(/<Link\s[^>]*?href="([^"]*)"/g)) {
        expect(
          ["/", "/judge", "/signin", "/verify", "/privacy", "/terms"],
          `${name}: <Link ${href}>`,
        ).toContain(href);
      }
    }
  });

  it("keeps the two liked lines and none of the copy tics", () => {
    const all = landingSources.map((file) => file.source).join("\n");
    expect(all).toContain("Every bot pays its <span");
    expect(all).toContain("Pay the fare, pal.");
    expect(all).not.toMatch(/[—“”]|&[lr]dquo;|&mdash;/);
    expect(all).not.toMatch(/\b(seamless|effortless|simply|instantly|powerful)\b/i);
    expect(all).not.toContain("npm i");
  });
});
