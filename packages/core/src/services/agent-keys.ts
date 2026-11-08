import { IdPrefix, newId } from "@botfare/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { JWK } from "jose";
import { z } from "zod";
import type { DbOrTx } from "../db";
import { type AgentKey, agentKeys } from "../schema";

/** Only the public half of an Ed25519 key is ever stored; a JWK carrying `d` is refused. */
const publicJwkSchema = z
  .object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1) })
  .loose()
  .refine((jwk) => !("d" in jwk), "Send the public key only, never the private key")
  .transform(({ kty, crv, x }): JWK => ({ kty, crv, x }));

const limitSchema = z.number().int().min(1).max(100_000).nullish();

export interface CreateAgentKeyInput {
  ownerUserId: string;
  name: string;
  publicJwk: JWK;
  perRequestMaxCents?: number | null;
  dailyCapCents?: number | null;
  /** null or omitted = any site. */
  allowedSiteIds?: string[] | null;
}

export async function createAgentKey(db: DbOrTx, input: CreateAgentKeyInput): Promise<AgentKey> {
  const [key] = await db
    .insert(agentKeys)
    .values({
      id: newId(IdPrefix.agentKey),
      ownerUserId: input.ownerUserId,
      name: z.string().trim().min(1).max(200).parse(input.name),
      publicJwk: publicJwkSchema.parse(input.publicJwk),
      perRequestMaxCents: limitSchema.parse(input.perRequestMaxCents) ?? null,
      dailyCapCents: limitSchema.parse(input.dailyCapCents) ?? null,
      allowedSiteIds: z.array(z.string()).max(100).nullish().parse(input.allowedSiteIds) ?? null,
    })
    .returning();
  if (!key) throw new Error("Failed to create agent key");
  return key;
}

export async function getAgentKeyById(db: DbOrTx, keyId: string): Promise<AgentKey | null> {
  const [key] = await db.select().from(agentKeys).where(eq(agentKeys.id, keyId));
  return key ?? null;
}

export function listAgentKeys(db: DbOrTx, ownerUserId: string): Promise<AgentKey[]> {
  return db
    .select()
    .from(agentKeys)
    .where(eq(agentKeys.ownerUserId, ownerUserId))
    .orderBy(desc(agentKeys.createdAt));
}

/**
 * Sets a key's limits in place (the facilitator reads them on every charge), so an operator can
 * raise a seeded key's caps without issuing a new secret. Null if the key does not exist.
 */
export async function updateAgentKeyLimits(
  db: DbOrTx,
  input: {
    keyId: string;
    perRequestMaxCents: number | null;
    dailyCapCents: number | null;
    allowedSiteIds?: string[] | null;
  },
): Promise<AgentKey | null> {
  const [key] = await db
    .update(agentKeys)
    .set({
      perRequestMaxCents: limitSchema.parse(input.perRequestMaxCents) ?? null,
      dailyCapCents: limitSchema.parse(input.dailyCapCents) ?? null,
      allowedSiteIds: z.array(z.string()).max(100).nullish().parse(input.allowedSiteIds) ?? null,
    })
    .where(eq(agentKeys.id, input.keyId))
    .returning();
  return key ?? null;
}

/** Revokes a key (idempotent). With `ownerUserId`, only that user's key. Null if not found. */
export async function revokeAgentKey(
  db: DbOrTx,
  input: { keyId: string; ownerUserId?: string },
): Promise<AgentKey | null> {
  const match = input.ownerUserId
    ? and(eq(agentKeys.id, input.keyId), eq(agentKeys.ownerUserId, input.ownerUserId))
    : eq(agentKeys.id, input.keyId);
  await db
    .update(agentKeys)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(match, eq(agentKeys.status, "active")));
  const [key] = await db.select().from(agentKeys).where(match);
  return key ?? null;
}
