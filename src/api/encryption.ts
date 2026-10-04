// End-to-end encryption helpers (Web Crypto, AES-GCM + PBKDF2).
// Documents are encrypted locally before they enter PouchDB, so replication
// only ever moves opaque ciphertext to/from the server.
//
// ponytail: only the note CONTENT is encrypted, not the _id/path. Path privacy
// would need deterministic id hashing; add that if metadata leakage matters.

const ITERATIONS = 200_000;
const SALT_LEN = 16;
const IV_LEN = 12;

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Output format: base64( salt[16] | iv[12] | ciphertext ), prefixed so we can
// tell encrypted payloads from plaintext on the way back in.
const PREFIX = "enc:";

export async function encryptString(
  plain: string,
  passphrase: string,
): Promise<string> {
  if (!passphrase) return plain;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const packed = new Uint8Array(salt.length + iv.length + ct.length);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(ct, salt.length + iv.length);
  return PREFIX + toB64(packed);
}

export async function decryptString(
  payload: string,
  passphrase: string,
): Promise<string> {
  if (!payload.startsWith(PREFIX)) return payload; // stored as plaintext
  if (!passphrase)
    throw new Error(
      "Document is encrypted but no passphrase is set for this remote.",
    );
  const packed = fromB64(payload.slice(PREFIX.length));
  const salt = packed.slice(0, SALT_LEN);
  const iv = packed.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ct = packed.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
