// Helpers for the repo-root .env used by the seed and e2e scripts. Secret values are never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const ENV_FILE = resolve(ROOT, ".env");

/** Loads the repo-root .env into process.env (variables already set in the shell win). */
export function loadRootEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

/**
 * Sets `KEY=value` lines in .env in place: an existing line for the key is replaced, a missing
 * key is appended, and every other line (comments included) is left untouched.
 */
export function updateEnvFile(values: Record<string, string>): void {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  writeFileSync(ENV_FILE, `${updated.join("\n")}\n`, { mode: 0o600 });
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

/** `…abcd`: enough to tell secrets apart in logs without revealing them. */
export function lastFour(secret: string): string {
  return `…${secret.slice(-4)}`;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`FAIL ${name} is not set. Copy .env.example to .env and run pnpm seed.`);
    process.exit(1);
  }
  return value;
}
