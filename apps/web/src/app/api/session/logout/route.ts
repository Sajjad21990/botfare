import { clearSessionCookie } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearSessionCookie();
  return Response.json({ ok: true });
}
