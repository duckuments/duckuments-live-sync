// API layer: everything that talks to the CouchDB server lives here.
// The sync engine and UI call these; they never build URLs or PouchDB handles
// themselves.
import PouchDB from "pouchdb-browser";
import type { RemoteVault } from "../settings";

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function basicAuthHeader(v: RemoteVault): string {
  return "Basic " + btoa(`${v.username}:${v.password}`);
}

/** A PouchDB handle for the remote CouchDB database of `v`. */
export function remoteDB(v: RemoteVault): PouchDB.Database {
  const url = `${trimSlash(v.couchURI)}/${encodeURIComponent(v.dbName)}`;
  return new PouchDB(url, {
    auth: { username: v.username, password: v.password },
    skip_setup: false,
  } as PouchDB.Configuration.RemoteDatabaseConfiguration);
}

/** A PouchDB handle for an arbitrary database name on the same server as `v`. */
export function remoteDBNamed(
  v: RemoteVault,
  dbName: string,
): PouchDB.Database {
  return remoteDB({ ...v, dbName });
}

/** Verify we can reach the server and the database. */
export async function testConnection(
  v: RemoteVault,
): Promise<{ ok: boolean; message: string }> {
  try {
    const info = await remoteDB(v).info();
    return {
      ok: true,
      message: `Connected: ${info.doc_count} docs in "${info.db_name}".`,
    };
  } catch (e) {
    return { ok: false, message: describeError(e) };
  }
}

/** List database names on the server (for PULL FROM / PUSH FROM choosers). */
export async function listRemoteVaults(v: RemoteVault): Promise<string[]> {
  const res = await fetch(`${trimSlash(v.couchURI)}/_all_dbs`, {
    headers: { Authorization: basicAuthHeader(v) },
  });
  if (!res.ok)
    throw new Error(`_all_dbs failed: ${res.status} ${res.statusText}`);
  const dbs = (await res.json()) as string[];
  // Hide CouchDB system databases.
  return dbs.filter((d) => !d.startsWith("_"));
}

export function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>;
    if (anyE.status === 401)
      return "Authentication failed (401). Check username/password.";
    if (anyE.status === 404)
      return "Database not found (404). Check the database name.";
    if (anyE.message) return String(anyE.message);
  }
  return String(e);
}
