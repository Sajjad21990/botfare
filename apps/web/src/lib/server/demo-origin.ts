/**
 * Server-side address mapping for the demo publisher, for when the BotFare server cannot reach the
 * demo at the origin it is registered under.
 *
 * In the judge Docker stack, Crema Notes is registered (and shown to people and to the model) as
 * http://localhost:4300, the port published on the host. Inside the web container, localhost is
 * the container itself, so the research agent must reach the demo at http://demo:4000 on the
 * compose network instead:
 *
 *   DEMO_PUBLIC_URL=http://localhost:4300   (or DEMO_ORIGIN) the origin the site is registered under
 *   DEMO_INTERNAL_URL=http://demo:4000      where this server actually connects
 *
 * Only requests whose origin is exactly the public origin are rewritten, and only to the
 * configured internal origin; path and query are kept. Everything the model, the UI and the
 * receipts see keeps the public URL. The rewritten request carries `X-Forwarded-Host` (and
 * `-Proto`) with the public host, so the publisher verifies the agent's Web Bot Auth signature,
 * which covers `@authority`, against the host it was signed for.
 */

export interface OriginRewrite {
  /** The public origin, e.g. http://localhost:4300. */
  from: string;
  /** Where this server connects instead, e.g. http://demo:4000. */
  to: string;
}

function originOf(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The demo's public origin: DEMO_PUBLIC_URL, else DEMO_ORIGIN; null when neither is set. */
export function demoPublicOrigin(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return originOf(env.DEMO_PUBLIC_URL) ?? originOf(env.DEMO_ORIGIN);
}

/** The configured mapping, or null when DEMO_INTERNAL_URL (or a public origin) is not set. */
export function demoOriginRewrite(
  env: Record<string, string | undefined> = process.env,
): OriginRewrite | null {
  const from = demoPublicOrigin(env);
  const to = originOf(env.DEMO_INTERNAL_URL);
  return from && to && from !== to ? { from, to } : null;
}

/** The URL this server should connect to: the internal origin for the demo, else unchanged. */
export function rewriteUrl(url: string, rewrite: OriginRewrite | null): string {
  if (!rewrite) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.origin !== rewrite.from) return url;
  const target = new URL(`${parsed.pathname}${parsed.search}`, rewrite.to);
  return target.href;
}

/**
 * A fetch that sends requests for the demo's public origin to its internal origin, with
 * X-Forwarded-Host/-Proto naming the public one. Other URLs pass through untouched.
 */
export function createRewritingFetch(
  rewrite: OriginRewrite | null,
  base: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!rewrite) return base;
  const publicUrl = new URL(rewrite.from);
  return async (input, init) => {
    const request = new Request(input, init);
    const target = rewriteUrl(request.url, rewrite);
    if (target === request.url) return base(request);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", publicUrl.protocol.replace(/:$/, ""));
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return base(
      new Request(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
        signal: request.signal,
        redirect: request.redirect,
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit),
    );
  };
}
