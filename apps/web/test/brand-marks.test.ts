import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotFareMark } from "../src/components/brand/bot-fare-mark";
import { FareAdvisorMark } from "../src/components/brand/fare-advisor-mark";
import { FareCourtMark } from "../src/components/brand/fare-court-mark";

const render = (mark: typeof BotFareMark, className?: string) =>
  renderToStaticMarkup(createElement(mark, { className }));

const ticketPath = (html: string) => html.match(/<path d="([^"]+)" fill="#ffd44d"/)?.[1];

describe.each([
  ["FareCourtMark", FareCourtMark],
  ["FareAdvisorMark", FareAdvisorMark],
])("%s", (_name, mark) => {
  it("is a decorative 64-grid svg sized like the Admit-bot", () => {
    const html = render(mark);
    expect(html).toMatch(/^<svg viewBox="0 0 64 64" aria-hidden="true" class="size-6 shrink-0"/);
    expect(html).not.toContain("<title");
  });

  it("takes a size from className", () => {
    expect(render(mark, "size-14")).toMatch(/class="shrink-0 size-14"/);
  });

  it("is printed on the same ticket as BotFareMark", () => {
    const ticket = ticketPath(render(BotFareMark));
    expect(ticket).toBeDefined();
    expect(ticketPath(render(mark))).toBe(ticket);
  });
});
