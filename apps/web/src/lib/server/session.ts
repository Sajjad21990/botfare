import "server-only";
import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import { createUser, getUserByEmail, getUserById, type User } from "@botfare/core";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "./db";

/**
 * Sessions are a signed JWT (HS256, SESSION_SECRET) in an httpOnly cookie holding the user ID.
 * Sign-in is a demo persona for judges (and Log in with PayPal later); there are no passwords.
 */
const COOKIE = "botfare_session";
const MAX_AGE_SECONDS = 7 * 24 * 3600;

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set to at least 32 characters in production");
  }
  // Local development without SESSION_SECRET: a fixed key, never used in production.
  return new TextEncoder().encode("botfare-local-dev-session-secret-not-for-production");
}

export async function createSessionCookie(userId: string): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in user, or null. */
export async function getSessionUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return payload.sub ? await getUserById(getDb(), payload.sub) : null;
  } catch {
    return null;
  }
}

/** For server components and actions: the signed-in user, or a redirect to /signin. */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/signin");
  return user;
}

/** For route handlers: the signed-in user, or a 401 JSON response. */
export async function requireApiUser(): Promise<{ user: User } | { response: Response }> {
  const user = await getSessionUser();
  return user
    ? { user }
    : {
        response: Response.json(
          { error: "unauthorized", message: "Sign in first" },
          { status: 401 },
        ),
      };
}

/** Finds or creates the persona's user (same emails as `pnpm seed`). */
export async function personaUser(persona: DemoPersona): Promise<User> {
  const { email, name } = DEMO_PERSONAS[persona];
  const db = getDb();
  return (await getUserByEmail(db, email)) ?? createUser(db, { email, name });
}
