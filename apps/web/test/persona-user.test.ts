/**
 * Persona sign-in finds the persona's user by email. The publisher persona once had another email;
 * when only that user exists, it is moved to the new email (core's migrateLegacyDemoPublisher)
 * instead of a fresh, site-less user being created.
 */
import { DEMO_PERSONAS } from "@botfare/contracts";
import type { User } from "@botfare/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("../src/lib/server/db", () => ({ getDb: () => ({}) }));

const core = vi.hoisted(() => ({
  users: new Map<string, User>(),
  legacy: null as User | null,
  calls: { migrate: 0, create: 0 },
}));

vi.mock("@botfare/core", () => ({
  getUserById: async () => null,
  getUserByEmail: async (_db: unknown, email: string) => core.users.get(email) ?? null,
  createUser: async (_db: unknown, input: { email: string; name: string }) => {
    core.calls.create++;
    const user = { id: `usr_new_${core.calls.create}`, ...input } as User;
    core.users.set(input.email, user);
    return user;
  },
  migrateLegacyDemoPublisher: async () => {
    core.calls.migrate++;
    if (!core.legacy) return { publisher: null, migrated: null, untouched: [] };
    const moved = { ...core.legacy, email: DEMO_PERSONAS.publisher.email } as User;
    core.users.set(moved.email, moved);
    core.legacy = null;
    return { publisher: moved, migrated: { userId: moved.id, from: "old" }, untouched: [] };
  },
}));

import { personaUser } from "../src/lib/server/session";

beforeEach(() => {
  core.users.clear();
  core.legacy = null;
  core.calls = { migrate: 0, create: 0 };
});

describe("personaUser", () => {
  it("returns the persona's existing user without migrating", async () => {
    const existing = { id: "usr_pub", email: DEMO_PERSONAS.publisher.email } as User;
    core.users.set(existing.email, existing);
    expect(await personaUser("publisher")).toBe(existing);
    expect(core.calls).toEqual({ migrate: 0, create: 0 });
  });

  it("moves the publisher from its old email, keeping the user ID", async () => {
    core.legacy = { id: "usr_old_publisher", email: "publisher@old.example" } as User;
    const user = await personaUser("publisher");
    expect(user.id).toBe("usr_old_publisher");
    expect(user.email).toBe(DEMO_PERSONAS.publisher.email);
    expect(core.calls).toEqual({ migrate: 1, create: 0 });
  });

  it("creates the publisher when there is no user to move", async () => {
    const user = await personaUser("publisher");
    expect(user.email).toBe(DEMO_PERSONAS.publisher.email);
    expect(core.calls).toEqual({ migrate: 1, create: 1 });
  });

  it("never migrates for the agent owner", async () => {
    core.legacy = { id: "usr_old_publisher", email: "publisher@old.example" } as User;
    const user = await personaUser("agentOwner");
    expect(user.email).toBe(DEMO_PERSONAS.agentOwner.email);
    expect(core.calls).toEqual({ migrate: 0, create: 1 });
  });
});
