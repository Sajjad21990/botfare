/**
 * Server-rendered HTML for people, with no JavaScript. Styles live in public/style.css (a free
 * static path). Every page is deterministic for its inputs, so the Fare Court stub's digest can be
 * recomputed outside the server (scripts/lib/fare-story.ts).
 */
import { type Article, SECTIONS, type Section, type SectionId, sectionById } from "./content";
import { escapeHtml } from "./markdown";
import { priceCentsFor, SITE_NAME, SITE_TAGLINE } from "./pricing";

type PricedArticle = Article & { priceCents: number };

const NAME = escapeHtml(SITE_NAME);
/** The text logo: the site name with its ampersand set in the accent colour. */
const LOGO = NAME.replace("&amp;", '<span class="amp">&amp;</span>');

/** 2 → "2¢", 150 → "$1.50", 0 → "free". */
export function fare(cents: number): string {
  if (cents <= 0) return "free";
  return cents >= 100 ? `$${(cents / 100).toFixed(2)}` : `${cents}¢`;
}

function layout(
  title: string,
  body: string,
  options: { current?: SectionId; description?: string } = {},
): string {
  const nav = SECTIONS.map(
    (section) =>
      `<a href="/${section.id}"${section.id === options.current ? ' aria-current="page"' : ""}>${escapeHtml(section.name)}</a>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(options.description ?? SITE_TAGLINE)}">
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="site-header">
<div class="wrap header-row">
<a href="/" class="logo"><img src="/static/favicon.svg" alt="" width="30" height="30"><span>${LOGO}</span></a>
<nav class="sections" aria-label="Sections">
${nav}
</nav>
</div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer">
<div class="wrap">
<p>People read ${NAME} free. AI agents pay per page through BotFare, and the money goes to the cook who wrote it.</p>
<p><a href="/catalog.json">catalog.json</a> · <a href="/api/nutrition?recipe=weeknight-red-lentil-dal">Nutrition API</a>, ${fare(priceCentsFor("GET", "/api/nutrition"))} a call for everyone</p>
<p>${NAME} is a fictional recipe blog. Its payments run in the PayPal sandbox.</p>
</div>
</footer>
</body>
</html>`;
}

function readingMinutes(article: Article): number {
  return Math.max(1, Math.round(article.wordCount / 230));
}

/** "Serves 4 · 40 minutes" for a recipe, "3 min read" for anything without a yield or time. */
function facts(article: Article): string[] {
  const known = [article.yield, article.time].filter((fact): fact is string => Boolean(fact));
  return known.length ? known : [`${readingMinutes(article)} min read`];
}

function card(article: PricedArticle): string {
  const meta = facts(article)
    .map((fact) => `<span>${escapeHtml(fact)}</span>`)
    .join("");
  return `<li class="card">
<a class="card-link" href="${article.path}">
<h3 class="card-title">${escapeHtml(article.title)}</h3>
<p class="excerpt">${escapeHtml(article.excerpt)}</p>
<p class="meta">${meta}<span class="fare">AI agents ${fare(article.priceCents)}</span></p>
</a>
</li>`;
}

function cards(articles: PricedArticle[]): string {
  if (!articles.length) return `<p class="empty">Nothing here yet.</p>`;
  return `<ul class="cards">
${articles.map(card).join("\n")}
</ul>`;
}

/** "2¢" when every page costs the same, "2¢ to 50¢" otherwise. */
function priceRange(articles: PricedArticle[]): string {
  const prices = articles.map((article) => article.priceCents);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? fare(low) : `${fare(low)} to ${fare(high)}`;
}

export function homePage(articles: PricedArticle[]): string {
  const shelves = SECTIONS.map((section) => {
    const pages = articles.filter((article) => article.section === section.id);
    if (!pages.length) return "";
    return `<section class="shelf" aria-labelledby="shelf-${section.id}">
<div class="shelf-head">
<h2 id="shelf-${section.id}"><a class="shelf-link" href="/${section.id}">${escapeHtml(section.name)}</a></h2>
<p>${escapeHtml(section.description)}</p>
</div>
${cards(pages)}
</section>`;
  }).join("\n");
  const access = articles.length
    ? `<p class="access">People read every page free. AI agents pay ${priceRange(articles)} a page, and each page shows its price.</p>`
    : "";
  return layout(
    SITE_NAME,
    `<section class="hero">
<h1>${escapeHtml(SITE_TAGLINE)}</h1>
<p class="lede">A home cook's recipes, the techniques behind them, a week of dinners from one shop, and a chapter from our cookbook.</p>
${access}
</section>
${shelves}`,
  );
}

export function sectionPage(section: Section, articles: PricedArticle[]): string {
  const access = articles.length
    ? `<p class="access">People read free. AI agents pay ${priceRange(articles)} a page.</p>`
    : "";
  return layout(
    `${section.name} · ${SITE_NAME}`,
    `<section class="hero hero-section">
<h1>${escapeHtml(section.name)}</h1>
<p class="lede">${escapeHtml(section.description)}</p>
${access}
</section>
${cards(articles)}`,
    { current: section.id, description: section.description },
  );
}

/** The markdown's leading `# Title` as the page heading, and the rest as the body. */
function splitHeading(article: Article): { heading: string; body: string } {
  const [first = "", ...rest] = article.html.split("\n");
  return first.startsWith("<h1>")
    ? { heading: first, body: rest.join("\n") }
    : { heading: `<h1>${escapeHtml(article.title)}</h1>`, body: article.html };
}

function crumb(article: Article): string {
  const section = sectionById(article.section);
  return section
    ? `<p class="crumb"><a class="crumb-link" href="/${section.id}">${escapeHtml(section.name)}</a></p>`
    : "";
}

/** What an AI agent pays for this page, as the note at the top of every article. */
export function fareNote(priceCents: number): string {
  return priceCents > 0
    ? `AI agents pay ${fare(priceCents)} to read this page. People read free.`
    : "Free for everyone, AI agents included.";
}

export function articlePage(
  article: Article,
  priceCents: number = priceCentsFor("GET", article.path),
): string {
  const section = sectionById(article.section);
  const { heading, body } = splitHeading(article);
  const meta = facts(article)
    .map((fact) => `<span>${escapeHtml(fact)}</span>`)
    .join("");
  return layout(
    `${article.title} · ${SITE_NAME}`,
    `<article class="post">
<header class="post-head">
${crumb(article)}
${heading}
<p class="meta">${meta}</p>
<p class="fare-note">${fareNote(priceCents)}</p>
</header>
<div class="post-body">
${body}
</div>
</article>
${section ? `<p class="back"><a class="back-link" href="/${section.id}">← ${escapeHtml(section.name)}</a></p>` : ""}`,
    { current: article.section, description: article.excerpt },
  );
}

/**
 * FARE COURT DEMO CASE: what a "bad publisher" sends a paying agent instead of the page its
 * preview promised: a teaser and a "subscribe to keep reading" wall. See FARE_COURT_STUB_SLUG.
 */
export function subscribeStubPage(article: Article): string {
  return layout(
    `${article.title} · ${SITE_NAME}`,
    `<article class="post">
<header class="post-head">
${crumb(article)}
<h1>${escapeHtml(article.title)}</h1>
</header>
<div class="post-body">
<p>${escapeHtml(article.excerpt)}</p>
<div class="paywall">
<h2>Subscribe to keep reading</h2>
<p>This guide is for ${NAME} subscribers. Subscribe for $4 a month to read the full guide and the rest of our archive.</p>
</div>
</div>
</article>`,
    { current: article.section, description: article.excerpt },
  );
}

export function notFoundPage(): string {
  return layout(
    `Not found · ${SITE_NAME}`,
    `<article class="post">
<h1>Page not found</h1>
<p>That page is not on the menu. Try the <a href="/recipes">recipes</a> or the <a href="/">home page</a>.</p>
</article>`,
  );
}
