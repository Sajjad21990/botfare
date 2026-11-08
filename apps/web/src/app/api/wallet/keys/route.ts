import { createAgentKey } from "@botfare/core";
import { z } from "zod";
import { getDb } from "../../../../lib/server/db";
import { jsonError, readJson } from "../../../../lib/server/http";
import { requireApiUser } from "../../../../lib/server/session";
import {
  listSiteDirectory,
  toWalletAgentKey,
  walletErrorResponse,
} from "../../../../lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Limits in cents: at most $1,000 per request or per day (the ledger allows the same). */
const capCents = z.number().int().min(1).max(100_000);

/**
 * The public half of an Ed25519 key pair generated in the browser. A JWK that carries the
 * private scalar `d` is refused outright: BotFare must never see the private key.
 */
const publicJwkSchema = z
  .object({
    kty: z.literal("OKP", { error: "publicJwk.kty must be OKP" }),
    crv: z.literal("Ed25519", { error: "publicJwk.crv must be Ed25519" }),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "publicJwk.x must be a 32-byte base64url key"),
  })
  .loose()
  .refine((jwk) => !("d" in jwk), {
    message: "publicJwk contains a private key (d). Send the public key only.",
  })
  .transform(({ kty, crv, x }) => ({ kty, crv, x }));

const bodySchema = z
  .object({
    name: z.string().trim().min(1, "Name the key").max(60),
    publicJwk: publicJwkSchema,
    perRequestMaxCents: capCents,
    dailyCapCents: capCents,
    /** Omit (or null) to let the key pay any BotFare site. */
    allowedSiteIds: z.array(z.string().min(1).max(64)).min(1).max(20).nullish(),
  })
  .refine((body) => body.perRequestMaxCents <= body.dailyCapCents, {
    message: "The per-request max cannot be higher than the daily cap",
    path: ["perRequestMaxCents"],
  });

/**
 * Registers a new agent key for the signed-in user. The browser generates the key pair and sends
 * only the public JWK; the response carries the key ID the browser needs to build the agent key.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiUser();
  if ("response" in auth) return auth.response;
  const body = await readJson(request, bodySchema);
  if (!body.ok) return body.response;
  const db = getDb();

  let allowedSiteIds: string[] | null = null;
  if (body.data.allowedSiteIds) {
    allowedSiteIds = [...new Set(body.data.allowedSiteIds)];
    const known = new Set((await listSiteDirectory(db)).map((site) => site.id));
    const unknown = allowedSiteIds.find((id) => !known.has(id));
    if (unknown) return jsonError(400, "unknown_site", `Unknown site ${unknown}`);
  }

  try {
    const key = await createAgentKey(db, {
      ownerUserId: auth.user.id,
      name: body.data.name,
      publicJwk: body.data.publicJwk,
      perRequestMaxCents: body.data.perRequestMaxCents,
      dailyCapCents: body.data.dailyCapCents,
      allowedSiteIds,
    });
    return Response.json({ key: toWalletAgentKey(key) }, { status: 201 });
  } catch (err) {
    return walletErrorResponse(err, "create agent key");
  }
}
