/** Articles live as markdown files with a small front matter block in `apps/demo/content`. */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { markdownToHtml, markdownToText } from "./markdown";

export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL("../content", import.meta.url));

const frontMatterSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  excerpt: z.string().min(1),
  priceCents: z.coerce.number().int().positive(),
});

export type FrontMatter = z.infer<typeof frontMatterSchema>;

export interface Article extends FrontMatter {
  /** Markdown body without the front matter. */
  markdown: string;
  html: string;
  /** Prose only (no headings), for previews. */
  lead: string;
  wordCount: number;
}

/** Parses `---\nkey: value\n---\nbody`. Values may be wrapped in double quotes. */
export function parseArticle(source: string): Article {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match?.[1] || match[2] === undefined) throw new Error("Article is missing front matter");
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const value = line.slice(colon + 1).trim();
    fields[line.slice(0, colon).trim()] = value.replace(/^"(.*)"$/, "$1").replaceAll('\\"', '"');
  }
  const front = frontMatterSchema.parse(fields);
  const markdown = match[2].trim();
  const words = markdownToText(markdown, { headings: true }).split(" ").filter(Boolean);
  return {
    ...front,
    markdown,
    html: markdownToHtml(markdown),
    lead: markdownToText(markdown),
    wordCount: words.length,
  };
}

/** All articles, sorted by slug. Each file name must match its slug. */
export function loadArticles(dir: string = DEFAULT_CONTENT_DIR): Article[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const article = parseArticle(readFileSync(join(dir, file), "utf8"));
      if (article.slug !== basename(file, ".md")) {
        throw new Error(`${file}: slug "${article.slug}" does not match the file name`);
      }
      return article;
    });
}

/** Cuts text to at most `max` characters at a word boundary, adding an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
