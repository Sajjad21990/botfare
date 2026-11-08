import { DEMO_PERSONAS } from "@botfare/contracts";
import { z } from "zod";
import { readJson } from "@/lib/server/http";
import { createSessionCookie, personaUser } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  persona: z.enum(Object.keys(DEMO_PERSONAS) as [keyof typeof DEMO_PERSONAS]),
});

/** Judge mode: sign in as a demo persona. */
export async function POST(request: Request) {
  const parsed = await readJson(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const user = await personaUser(parsed.data.persona);
  await createSessionCookie(user.id);
  return Response.json({
    user: { id: user.id, email: user.email, name: user.name },
    home: DEMO_PERSONAS[parsed.data.persona].home,
  });
}
