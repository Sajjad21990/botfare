import { vi } from "vitest";

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = MockReply | ((call: RecordedCall) => MockReply | Promise<MockReply>);

export const TOKEN_REPLY: MockReply = {
  body: { access_token: "A21AAtest-token-value", token_type: "Bearer", expires_in: 32400 },
};

/**
 * A fake `fetch` that routes on "METHOD /path" and records every call.
 * The token route answers with TOKEN_REPLY unless overridden.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const all: Record<string, Handler> = { "POST /v1/oauth2/token": TOKEN_REPLY, ...routes };

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    if (raw !== undefined && headers["content-type"] === "application/json") body = JSON.parse(raw);
    const call: RecordedCall = { method, url: url.toString(), path: url.pathname, headers, body };
    calls.push(call);

    const handler = all[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    const reply = typeof handler === "function" ? await handler(call) : handler;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });

  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    callsTo: (route: string) => calls.filter((c) => `${c.method} ${c.path}` === route),
  };
}
