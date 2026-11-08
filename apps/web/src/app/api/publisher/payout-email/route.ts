import { getPayoutEmail, setPayoutEmail } from "@botfare/core";
import { z } from "zod";
import { getDb } from "../../../../lib/server/db";
import { readJson } from "../../../../lib/server/http";
import { moneyErrorResponse, NO_STORE } from "../../../../lib/server/publisher";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** "" or null clears it (payouts then fall back to the first site's email). */
  email: z
    .union([z.literal(""), z.null(), z.string().trim().pipe(z.email("Enter a valid PayPal email"))])
    .transform((email) => email || null),
});

/** Sets where the signed-in publisher's payouts go. */
export async function PUT(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const body = await readJson(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    const db = getDb();
    const user = await setPayoutEmail(db, { userId: auth.user.id, email: body.data.email });
    return Response.json(
      {
        payoutEmail: await getPayoutEmail(db, auth.user.id),
        payoutEmailOnProfile: Boolean(user.payoutEmail),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return moneyErrorResponse(err);
  }
}
