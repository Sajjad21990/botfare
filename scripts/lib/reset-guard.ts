/** The safety checks for `pnpm db:reset` (scripts/reset-db.ts). */

export const CONFIRM_FLAG = "--yes-delete-everything";
export const ALLOW_LOCAL_FLAG = "--allow-local";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The database a URL points at, without credentials: "host/name". */
export function describeTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`;
}

/** Why the reset must not run with these arguments, or null when it may. */
export function refusalFor(url: string, args: readonly string[]): string | null {
  if (!args.includes(CONFIRM_FLAG)) {
    return `This deletes every table in ${describeTarget(url)}. Run again with ${CONFIRM_FLAG} to confirm.`;
  }
  if (LOCAL_HOSTS.has(new URL(url).hostname) && !args.includes(ALLOW_LOCAL_FLAG)) {
    return `${describeTarget(url)} is on this machine. Local databases are only reset with ${ALLOW_LOCAL_FLAG} as well.`;
  }
  return null;
}
