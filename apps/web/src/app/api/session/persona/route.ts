import { DEMO_PERSONAS } from "@botfare/contracts";
import { z } from "zod";
import { readJson } from "../../../../lib/server/http";
import { prepareDemoPersona } from "../../../../lib/server/judge";
import { createSessionCookie, personaUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  persona: z.enum(Object.keys(DEMO_PERSONAS) as [keyof typeof DEMO_PERSONAS]),
});

/**
 * Judge mode: sign in as a demo persona. Every judge shares these users, so the persona's demo
 * state is restored first and the actions that would break the demo are locked (lib/server/judge).
 */
export async function POST(request: Request) {
  const parsed = await readJson(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const user = await personaUser(parsed.data.persona);
  await prepareDemoPersona(parsed.data.persona, user);
  await createSessionCookie(user.id, request);
  return Response.json({
    user: { id: user.id, email: user.email, name: user.name },
    home: DEMO_PERSONAS[parsed.data.persona].home,
  });
}
