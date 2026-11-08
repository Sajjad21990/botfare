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
