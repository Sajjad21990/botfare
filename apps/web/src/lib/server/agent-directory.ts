import {
  BOTFARE_KEY_ID_MEMBER,
  type DirectoryJwk,
  isEd25519PublicJwk,
  jwkThumbprint,
  type SignatureDirectory,
} from "@botfare/contracts/web-bot-auth";
import { type DbOrTx, schema } from "@botfare/core";

/**
 * BotFare's Web Bot Auth key directory: the public keys of agent keys, keyed by their RFC 7638
 * JWK thumbprint (the `keyid` agents put in their request signatures).
 *
 * Thumbprints are derived on the fly (a key's public JWK never changes, so they are memoized by
 * key ID). There are few keys, so every key is read and filtered here.
 */

interface KeyRow {
  id: string;
  publicJwk: unknown;
  status: "active" | "revoked";
}

export interface DirectoryEntry {
  keyId: string;
  thumbprint: string;
  status: "active" | "revoked";
  jwk: DirectoryJwk;
}

const thumbprints = new Map<string, string>();

async function readEntries(db: DbOrTx): Promise<DirectoryEntry[]> {
  const rows: KeyRow[] = await db
    .select({
      id: schema.agentKeys.id,
      publicJwk: schema.agentKeys.publicJwk,
      status: schema.agentKeys.status,
    })
    .from(schema.agentKeys);

  const entries: DirectoryEntry[] = [];
  for (const row of rows) {
    if (!isEd25519PublicJwk(row.publicJwk)) continue;
    let thumbprint = thumbprints.get(row.id);
    if (!thumbprint) {
      thumbprint = await jwkThumbprint(row.publicJwk);
      thumbprints.set(row.id, thumbprint);
    }
    entries.push({
      keyId: row.id,
      thumbprint,
      status: row.status,
      // Public members only, whatever else the stored JWK carries.
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: row.publicJwk.x,
        kid: thumbprint,
        use: "sig",
        [BOTFARE_KEY_ID_MEMBER]: row.id,
      },
    });
  }
  return entries;
}

/** The JWKS at SIGNATURE_DIRECTORY_PATH: every active agent key, oldest first by key ID. */
export async function buildSignatureDirectory(db: DbOrTx): Promise<SignatureDirectory> {
  const entries = await readEntries(db);
  return {
    keys: entries
      .filter((entry) => entry.status === "active")
      .sort((a, b) => a.keyId.localeCompare(b.keyId))
      .map((entry) => entry.jwk),
  };
}

/** The agent key with this thumbprint (active or revoked), or null. */
export async function findAgentByThumbprint(
  db: DbOrTx,
  thumbprint: string,
): Promise<{ keyId: string; status: "active" | "revoked" } | null> {
  const entry = (await readEntries(db)).find((e) => e.thumbprint === thumbprint);
  return entry ? { keyId: entry.keyId, status: entry.status } : null;
}

/** A JWK SHA-256 thumbprint: 43 base64url characters. */
export function isThumbprint(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
