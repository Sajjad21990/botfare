import { createSite } from "@botfare/core";
import { z } from "zod";
import { getDb } from "../../../../lib/server/db";
import { readJson } from "../../../../lib/server/http";
import { moneyErrorResponse, NO_STORE, toSiteView } from "../../../../lib/server/publisher";
import { requireApiUser } from "../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSiteSchema = z.object({
  name: z.string().trim().min(1, "Give the site a name").max(200),
  origin: z
    .string()
    .trim()
    .refine(
      (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
      "Enter the site's http or https address, e.g. https://saffron-and-salt.example",
    ),
  payoutEmail: z
    .union([z.literal(""), z.email("Enter a valid PayPal email")])
    .nullish()
    .transform((email) => email || null),
});

/**
 * Registers a site for the signed-in publisher. Prices start empty (nothing is charged until a
 * rule is saved). The site secret is in this response only; BotFare stores its hash.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const body = await readJson(request, createSiteSchema);
  if (!body.ok) return body.response;
  try {
    const { site, siteSecret } = await createSite(getDb(), {
      ownerUserId: auth.user.id,
      name: body.data.name,
      origin: body.data.origin,
      payoutEmail: body.data.payoutEmail,
      pricing: [],
    });
    return Response.json(
      { site: toSiteView(site, undefined, auth.user.email), siteSecret },
      { status: 201, headers: NO_STORE },
    );
  } catch (err) {
    return moneyErrorResponse(err);
  }
}
