import { pingDb } from "../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness plus a database check. */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true, db: await pingDb() });
}
