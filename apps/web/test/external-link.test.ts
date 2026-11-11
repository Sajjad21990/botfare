import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewTabLink, newTab } from "../src/components/app/external-link";

describe("NewTabLink", () => {
  it("opens a new tab without an opener and tells screen readers", () => {
    const html = renderToStaticMarkup(
      createElement(NewTabLink, { href: "https://example.test/page", className: "x" }, "Source"),
    );
    expect(html).toContain('href="https://example.test/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('class="x"');
    expect(html).toContain('<span class="sr-only"> (opens in a new tab)</span>');
    expect(html).not.toContain("<svg");
  });

  it("adds a hidden arrow icon only when asked", () => {
    const html = renderToStaticMarkup(
      createElement(NewTabLink, { href: "/verify", icon: true }, "Verify a receipt"),
    );
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("adds extra classes to the arrow", () => {
    const html = renderToStaticMarkup(
      createElement(
        NewTabLink,
        { href: "/verify", icon: true, iconClassName: "ml-0.5" },
        "Verify a receipt",
      ),
    );
    expect(html).toMatch(/<svg[^>]*class="[^"]*inline size-3\.5 shrink-0 ml-0\.5/);
  });

  it("keeps target and rel fixed", () => {
    expect(newTab).toEqual({ target: "_blank", rel: "noopener noreferrer" });
  });
});
