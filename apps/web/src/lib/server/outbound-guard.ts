import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound requests the research agent makes on behalf of a judge (catalogs, offers, purchases)
 * go to publisher origins that people register, so they must not reach this server's own network.
 *
 * - Redirects are never followed (a public page cannot bounce the agent to an internal address).
 * - In production, every host is resolved before the request, and the request is refused when any
 *   address is loopback, private, link-local, CGNAT, unspecified, multicast or reserved, including
 *   IPv4-mapped and NAT64 IPv6 forms. Trusted origins (the configured demo publisher, which may be
 *   on a private network in the judge Docker stack) skip the address check.
 *
 * Known limit: the address is checked by a lookup just before the request, and fetch resolves the
 * name again to connect, so a DNS server answering differently within that moment (DNS rebinding)
 * is not caught. The research agent only sends GETs without cookies.
 */

export class OutboundRequestError extends Error {
  override name = "OutboundRequestError";
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function isPrivateIPv4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The eight 16-bit groups of an IPv6 address, or null. Accepts a trailing dotted IPv4. */
function parseIPv6(address: string): number[] | null {
  let text = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1]) {
    const v4 = parseIPv4(dotted[1]);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string | undefined) => (half ? half.split(":") : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const values = all.map((group) =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return values.length === 8 && values.every((value) => !Number.isNaN(value)) ? values : null;
}

function embeddedIPv4(groups: number[], from: number): number[] {
  const hi = groups[from] ?? 0;
  const lo = groups[from + 1] ?? 0;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** True for an IP address this server must not be pointed at; also for anything unparseable. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPrivateIPv4(v4);
  const g = parseIPv6(address);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::/96: unspecified, loopback and the deprecated IPv4-compatible addresses.
  if (zeroPrefix && g5 === 0) return true;
  if (zeroPrefix && g5 === 0xffff) return isPrivateIPv4(embeddedIPv4(g, 6)); // IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(embeddedIPv4(g, 6)); // NAT64
  }
  if (g0 === 0x2002) return isPrivateIPv4(embeddedIPv4(g, 1)); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) // discard
  );
}

/** Private by its name alone: localhost names and private IP literals (brackets allowed). */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Refuses a host that is, or resolves to, a private address. */
export async function assertPublicHost(
  hostname: string,
  resolve: Resolver = systemResolver,
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateHostname(host)) {
    throw new OutboundRequestError(`${host} is a private address; the agent does not go there`);
  }
  if (isIP(host) !== 0) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new OutboundRequestError(`${host} could not be resolved`);
  }
  if (addresses.length === 0) throw new OutboundRequestError(`${host} could not be resolved`);
  if (addresses.some(isPrivateAddress)) {
    throw new OutboundRequestError(
      `${host} resolves to a private address; the agent does not go there`,
    );
  }
}

export interface GuardedFetchOptions {
  /** Check every host's addresses (production). Redirects are refused either way. */
  checkAddresses: boolean;
  /** Origins exempt from the address check: the configured demo publisher. */
  trustedOrigins?: string[];
  resolve?: Resolver;
}

/** A fetch for the research agent: no redirects, and no private addresses in production. */
export function createGuardedFetch(base: typeof fetch, options: GuardedFetchOptions): typeof fetch {
  const trusted = new Set(
    (options.trustedOrigins ?? []).flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    }),
  );
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new OutboundRequestError(`${url.protocol} URLs are not fetched`);
    }
    if (options.checkAddresses && !trusted.has(url.origin)) {
      await assertPublicHost(url.hostname, options.resolve);
    }
    const response = await base(new Request(request, { redirect: "manual" }));
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw new OutboundRequestError(
        `${url.origin}${url.pathname} answered with a redirect (HTTP ${response.status}); redirects are not followed`,
      );
    }
    return response;
  };
}
