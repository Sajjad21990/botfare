/**
 * Pages live as markdown files with a small front matter block in `apps/demo/content`. The
 * `section` field puts each page under its URL prefix: `/recipes/<slug>`, `/techniques/<slug>`,
 * `/meal-plans/<slug>` or `/cookbook/<slug>`, which is also how the site prices them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { markdownToHtml, markdownToText } from "./markdown";

export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL("../content", import.meta.url));

/** The site's sections, in nav order. Each `id` is a URL prefix with a free index page. */
export const SECTIONS = [
  {
    id: "recipes",
    name: "Recipes",
    description: "Recipes with weights, timings, and temperatures in °C and °F.",
  },
  {
    id: "techniques",
    name: "Techniques",
    description: "The methods the recipes rely on, explained once in full.",
  },
  {
    id: "meal-plans",
    name: "Meal plans",
    description: "A week of dinners from one shop, with the shopping list.",
  },
  {
    id: "cookbook",
    name: "Cookbook",
    description: "Chapters from our cookbook.",
  },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
export type Section = (typeof SECTIONS)[number];

const SECTION_IDS = SECTIONS.map((section) => section.id) as [SectionId, ...SectionId[]];

/** The section with this URL prefix (case-insensitive), if there is one. */
export function sectionById(id: string): Section | undefined {
  const wanted = id.toLowerCase();
  return SECTIONS.find((section) => section.id === wanted);
}

const frontMatterSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  section: z.enum(SECTION_IDS),
  title: z.string().min(1),
  excerpt: z.string().min(1),
  priceCents: z.coerce.number().int().positive(),
  /** Position within the section (lowest first); pages without one sort last, by slug. */
  order: z.coerce.number().int().optional(),
  /** What it makes, e.g. "Serves 4". */
  yield: z.string().min(1).optional(),
  /** How long it takes, e.g. "40 minutes". */
  time: z.string().min(1).optional(),
});

export type FrontMatter = z.infer<typeof frontMatterSchema>;

export interface Article extends FrontMatter {
  /** `/<section>/<slug>`: where the page is served and priced. */
  path: string;
  /** Markdown body without the front matter. */
  markdown: string;
  html: string;
  /** Prose only (no headings), for previews. */
  lead: string;
  wordCount: number;
}

/** `/<section>/<slug>` */
export function articlePath(section: SectionId, slug: string): string {
  return `/${section}/${slug}`;
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
    path: articlePath(front.section, front.slug),
    markdown,
    html: markdownToHtml(markdown),
    lead: markdownToText(markdown),
    wordCount: words.length,
  };
}

/**
 * All pages, in section order, then by `order`, then by slug. Each file name must match its slug,
 * and slugs are unique across sections.
 */
export function loadArticles(dir: string = DEFAULT_CONTENT_DIR): Article[] {
  const sectionIndex = (article: Article) => SECTION_IDS.indexOf(article.section);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const article = parseArticle(readFileSync(join(dir, file), "utf8"));
      if (article.slug !== basename(file, ".md")) {
        throw new Error(`${file}: slug "${article.slug}" does not match the file name`);
      }
      return article;
    })
    .sort(
      (a, b) =>
        sectionIndex(a) - sectionIndex(b) ||
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
        a.slug.localeCompare(b.slug),
    );
}

/** Cuts text to at most `max` characters at a word boundary, adding an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
