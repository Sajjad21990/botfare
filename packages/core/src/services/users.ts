import { IdPrefix, newId } from "@botfare/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db";
import { type User, users } from "../schema";

const createUserSchema = z.object({
  email: z.email().transform((email) => email.trim().toLowerCase()),
  name: z.string().trim().min(1).max(200),
});

export async function createUser(
  db: DbOrTx,
  input: { email: string; name: string },
): Promise<User> {
  const { email, name } = createUserSchema.parse(input);
  const [user] = await db
    .insert(users)
    .values({ id: newId(IdPrefix.user), email, name })
    .returning();
  if (!user) throw new Error("Failed to create user");
  return user;
}

export async function getUserByEmail(db: DbOrTx, email: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  return user ?? null;
}

export async function getUserById(db: DbOrTx, userId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}
