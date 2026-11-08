import { type SiteConfig, siteConfigPath, siteConfigSchema } from "@botfare/contracts";

/** How long one config fetch may hold up a request. */
const FETCH_TIMEOUT_MS = 3_000;
/** After a failed fetch, wait this long (or the TTL, if shorter) before trying again. */
const RETRY_AFTER_FAILURE_MS = 5_000;

export interface ConfigCacheOptions {
  botfareUrl: string;
  siteId: string;
  authHeader: string;
  ttlMs: number;
  log: (msg: string) => void;
}

/**
 * The site's pricing config, fetched from BotFare and cached for `ttlMs`.
 *
 * A stale config is refreshed by the next request, which waits for at most one fetch
 * (concurrent requests share it). A failed fetch keeps the last good config and backs off,
 * so a BotFare outage never slows every request down. Before the first successful fetch
 * `get()` returns `undefined` and the middleware lets everything through.
 */
export class SiteConfigCache {
  private config: SiteConfig | undefined;
  private fetchedAt = 0;
  private failedAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly url: string;

  constructor(private readonly options: ConfigCacheOptions) {
    this.url = new URL(siteConfigPath(options.siteId), options.botfareUrl).toString();
  }

  async get(): Promise<SiteConfig | undefined> {
    const now = Date.now();
    if (this.config && now - this.fetchedAt < this.options.ttlMs) return this.config;
    const backoff = Math.min(this.options.ttlMs, RETRY_AFTER_FAILURE_MS);
    if (now - this.failedAt >= backoff) await this.refresh();
    return this.config;
  }

  /** Starts a fetch, or joins the one already running. Never rejects. */
  refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(this.url, {
        headers: { authorization: this.options.authHeader, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const config = siteConfigSchema.parse(await res.json());
      if (config.siteId !== this.options.siteId) {
        throw new Error(`config is for ${config.siteId}, not ${this.options.siteId}`);
      }
      if (config.version !== this.config?.version) {
        this.options.log(`site config version ${config.version} loaded`);
      }
      this.config = config;
      this.fetchedAt = Date.now();
      this.failedAt = 0;
    } catch (err) {
      this.failedAt = Date.now();
      const kept = this.config ? `keeping version ${this.config.version}` : "no config yet";
      this.options.log(`site config fetch failed (${(err as Error).message}); ${kept}`);
    }
  }
}
