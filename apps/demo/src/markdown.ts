/**
 * A deliberately tiny markdown renderer for our own articles: `#` headings, paragraphs, `-` and
 * `1.` lists, `**bold**`, `*italic*`, `` `code` `` and `[links](/path)`. Everything is
 * HTML-escaped first, so the output is safe even if an article contains `<` or `&`.
 */

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]*)\)/g, '<a href="$2">$1</a>');
}

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  const state: { paragraph: string[]; list: { tag: "ul" | "ol"; items: string[] } | null } = {
    paragraph: [],
    list: null,
  };

  const flushParagraph = () => {
    if (state.paragraph.length) out.push(`<p>${inline(state.paragraph.join(" "))}</p>`);
    state.paragraph = [];
  };
  const flushList = () => {
    if (state.list) {
      const { tag, items } = state.list;
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
    }
    state.list = null;
  };
  const addItem = (tag: "ul" | "ol", text: string) => {
    flushParagraph();
    if (state.list?.tag !== tag) flushList();
    state.list ??= { tag, items: [] };
    state.list.items.push(text);
  };

  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const lastItem = state.list ? state.list.items.length - 1 : -1;

    if (!line) {
      flushParagraph();
      flushList();
    } else if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet?.[1] !== undefined) {
      addItem("ul", bullet[1]);
    } else if (numbered?.[1] !== undefined) {
      addItem("ol", numbered[1]);
    } else if (state.list && lastItem >= 0 && /^\s/.test(raw)) {
      // an indented line continues the previous list item
      state.list.items[lastItem] += ` ${line}`;
    } else {
      flushList();
      state.paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}

/** The article as plain prose: markup removed, headings dropped, one space between words. */
export function markdownToText(markdown: string, { headings = false } = {}): string {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => headings || !HEADING.test(line))
    .map((line) =>
      line
        .replace(HEADING, "$2")
        .replace(BULLET, "$1")
        .replace(NUMBERED, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*`]/g, ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
