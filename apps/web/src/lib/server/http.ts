import type { z } from "zod";

/** A JSON error body `{ error, message }`. */
export function jsonError(
  status: number,
  error: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error, message }, { status, headers });
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Reads a JSON body and validates it; a 400 response on malformed JSON or shape. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<Parsed<z.output<S>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: jsonError(400, "invalid_json", "Body must be JSON") };
  }
  return validate(body, schema);
}

function validate<S extends z.ZodType>(body: unknown, schema: S): Parsed<z.output<S>> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      response: jsonError(400, "invalid_request", `${where}${issue?.message ?? "Invalid body"}`),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Like readJson, but reads at most `maxBytes` of the body (whatever Content-Length says) and
 * answers 413 past that. Also returns the body's size.
 */
export async function readLimitedJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<{ ok: true; data: z.output<S>; bytes: number } | { ok: false; response: Response }> {
  const tooLarge = () => ({
    ok: false as const,
    response: jsonError(413, "too_large", "The request is too large"),
  });
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return tooLarge();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, response: jsonError(400, "invalid_json", "Body must be JSON") };
  }
  const parsed = validate(body, schema);
  return parsed.ok ? { ...parsed, bytes } : parsed;
}
