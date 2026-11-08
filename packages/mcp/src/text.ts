/** Formatting helpers: readable text from paid responses, and dollar amounts. */

/** "$0.03"; sub-cent amounts keep up to 4 decimals ("$0.0285"). */
export function formatUsd(usd: number): string {
  const cents = usd * 100;
  if (Math.abs(cents - Math.round(cents)) < 1e-6) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4).replace(/0+$/, "")}`;
}

/** Whole cents in a dollar amount, rounded down (a cap is never looser than asked). */
export function usdToCents(usd: number): number {
  return Math.floor(usd * 100 + 1e-6);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  deg: "°",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** The page's <title>, if any. */
export function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
  return title || undefined;
}

/**
 * Plain, readable text from HTML: scripts, styles and markup dropped; headings, paragraphs and
 * list items kept on their own lines (headings as `#`, items as `-`). Not a full HTML parser,
 * just enough for an LLM to read an article.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd|hr)\b[^>]*>/gi,
      "\n\n",
    )
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Cuts `text` to `max` characters, saying so. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... truncated: showing ${max} of ${text.length} characters]`;
}
