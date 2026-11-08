/** Server-rendered HTML for humans. Styles live in public/style.css (a free static path). */
import type { Article } from "./content";
import { escapeHtml } from "./markdown";
import { SITE_NAME, SITE_TAGLINE } from "./pricing";

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="masthead"><a href="/" class="brand">${SITE_NAME}</a><span class="tag">${escapeHtml(SITE_TAGLINE)}</span></header>
<main>
${body}
</main>
<footer>
<p>People read ${SITE_NAME} for free. AI agents pay a small fare per page through BotFare, and the money goes to the writers.</p>
<p><a href="/catalog.json">catalog.json</a> · <a href="/api/brew-ratio?method=v60&amp;coffeeGrams=15">brew-ratio API</a> (1¢ per call)</p>
</footer>
</body>
</html>`;
}

function fare(cents: number): string {
  return cents >= 100 ? `$${(cents / 100).toFixed(2)}` : `${cents}¢`;
}

export function indexPage(articles: Array<Article & { priceCents: number }>): string {
  const items = articles
    .map(
      (a) => `<li class="card">
  <a href="/articles/${a.slug}"><h2>${escapeHtml(a.title)}</h2></a>
  <p>${escapeHtml(a.excerpt)}</p>
  <p class="meta">${a.wordCount} words · ${Math.max(1, Math.round(a.wordCount / 230))} min read · <span class="fare">agents pay ${fare(a.priceCents)}</span></p>
</li>`,
    )
    .join("\n");
  return layout(
    SITE_NAME,
    `<section class="intro">
<h1>${SITE_NAME}</h1>
<p>Practical, tested notes for brewing better coffee at home. <strong>Humans read everything free.</strong> AI agents pay a fare of a few cents per article, settled on PayPal.</p>
</section>
<ul class="articles">
${items}
</ul>`,
  );
}

export function articlePage(article: Article): string {
  return layout(
    `${article.title} · ${SITE_NAME}`,
    `<article>
<p class="meta">${article.wordCount} words · free for humans</p>
${article.html}
</article>
<p class="back"><a href="/">← All articles</a></p>`,
  );
}

export function notFoundPage(): string {
  return layout(
    `Not found · ${SITE_NAME}`,
    `<article><h1>Page not found</h1><p>That page is not on the menu. <a href="/">See all articles</a>.</p></article>`,
  );
}
