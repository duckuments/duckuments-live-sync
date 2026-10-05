// Sync engine: maps vault files <-> CouchDB docs, runs manual push/pull and
// live continuous replication.
//
// Model:
//  - Manual PUSH / PULL (incl. ...FROM a chosen remote) operate file <-> remote
//    directly, re-encrypting with that remote's own passphrase. This is what
//    makes multi-remote + E2EE work without a transform plugin.
//  - LIVE sync keeps a local PouchDB mirrored with the *default* remote (both
//    hold ciphertext under the default passphrase) and reflects changes into
//    the vault. See reflectDocToVault / upsertToLocal for the loop guard.
import { type App, TFile, TFolder, normalizePath } from "obsidian";
import PouchDB from "pouchdb-browser";
import type { RemoteVault, LiveSyncSettings } from "../settings";
import { remoteDB } from "../api/routes";
import {
  encryptString,
  decryptString,
  decryptHKDF,
  OLS_HKDF_PREFIX,
} from "../api/encryption";
import { isSyncable, type NoteDoc } from "./mapping";
import { logger } from "../log";

export type SyncStatus = "off" | "synced" | "dirty" | "syncing" | "error";

export class SyncEngine {
  private localDB: PouchDB.Database<NoteDoc> | null = null;
  private syncHandler: PouchDB.Replication.Sync<NoteDoc> | null = null;
  private changesHandler: PouchDB.Core.Changes<NoteDoc> | null = null;
  private defaultVault: RemoteVault | null = null;
  private dirty = false;
  // obsidian-livesync shares one PBKDF2 salt per remote (its _local sync-params
  // doc). Cache the decoded salt per remote db; null = no OLS E2EE on that db.
  private olsSaltCache = new Map<string, Uint8Array<ArrayBuffer> | null>();

  constructor(
    private app: App,
    private settings: LiveSyncSettings,
    private persist: () => Promise<void>,
    public onStatus: (s: SyncStatus, msg?: string) => void = () => {},
  ) {}

  // ---- lifecycle -------------------------------------------------------

  /** (Re)configure which remote live sync uses, restarting it if running. */
  async configure(
    defaultVault: RemoteVault | null,
    live: boolean,
  ): Promise<void> {
    const wasLive = !!this.syncHandler;
    this.stopLive();
    this.defaultVault = defaultVault;
    if (live && defaultVault) {
      await this.startLive();
    } else if (wasLive) {
      this.onStatus("off");
    } else {
      this.onStatus(this.dirty ? "dirty" : "off");
    }
  }

  destroy(): void {
    this.stopLive();
    this.localDB?.close().catch(() => {});
    this.localDB = null;
  }

  private db(): PouchDB.Database<NoteDoc> {
    if (!this.localDB) {
      const name = `duckuments-livesync-${this.app.vault.getName()}`;
      this.localDB = new PouchDB<NoteDoc>(name);
    }
    return this.localDB;
  }

  // ---- manual commands (file <-> remote directly) ----------------------

  /** Upload every syncable vault file to `v`, overwriting the remote copy. */
  async pushTo(v: RemoteVault): Promise<number> {
    this.onStatus("syncing", `Pushing to "${v.name}"...`);
    const db = remoteDB(v);
    // Pull-before-push guard: update_seq is the remote "HEAD". If it moved since
    // we last synced, someone else pushed — refuse until the user pulls.
    const info = await db.info();
    const base = this.settings.lastSeq[v.id];
    const behind =
      base === undefined
        ? info.doc_count > 0
        : base !== String(info.update_seq);
    if (behind) {
      const msg = `"${v.name}" has remote changes — pull before pushing.`;
      this.onStatus("error", msg);
      throw new Error(`"${v.name}" has remote changes. Pull first, then push.`);
    }
    const files = this.app.vault.getFiles().filter(isSyncable);
    // Empty folders have no file, so sync them as marker docs so they survive
    // the round-trip (CouchDB has no folder concept).
    const emptyFolders = this.app.vault
      .getAllLoadedFiles()
      .filter(
        (f): f is TFolder =>
          f instanceof TFolder && f.path !== "/" && f.children.length === 0,
      );
    const ids = [
      ...files.map((f) => f.path),
      ...emptyFolders.map((f) => f.path),
    ];
    const existing = await db.allDocs({ keys: ids });
    const revMap = new Map<string, string>();
    for (const row of existing.rows) {
      if ("value" in row && row.value && !row.value.deleted)
        revMap.set(row.id, row.value.rev);
    }
    const docs: NoteDoc[] = [];
    for (const f of files) {
      const content = await this.app.vault.read(f);
      docs.push({
        _id: f.path,
        _rev: revMap.get(f.path),
        path: f.path,
        mtime: f.stat.mtime,
        ctime: f.stat.ctime,
        type: "plain",
        data: await encryptString(content, v.passphrase),
      });
    }
    for (const folder of emptyFolders) {
      docs.push({
        _id: folder.path,
        _rev: revMap.get(folder.path),
        path: folder.path,
        mtime: 0,
        ctime: 0,
        type: "folder",
        data: "",
      });
    }
    if (docs.length) await db.bulkDocs(docs);
    // ponytail: push upserts present files/empty folders; it does not delete
    // remote docs for locally-removed ones. Live sync handles deletions.
    // Record the new base. ponytail: tiny window — a write landing between
    // bulkDocs and this info() read would be stored as "seen"; fails safe
    // (worst case we overwrote it just now, which push already does).
    this.settings.lastSeq[v.id] = String((await db.info()).update_seq);
    await this.persist();
    this.dirty = false;
    this.onStatus(
      "synced",
      `Pushed ${files.length} notes, ${emptyFolders.length} empty folders.`,
    );
    return docs.length;
  }

  /** Download every doc from `v` into the vault. */
  async pullFrom(v: RemoteVault): Promise<number> {
    this.onStatus("syncing", `Pulling from "${v.name}"...`);
    const db = remoteDB(v);
    // Read the base seq BEFORE allDocs so it's never newer than what we pulled
    // (conservative: a later interleaved write stays "unseen" → safe pull-first).
    const info = await db.info();
    const res = await db.allDocs<Record<string, unknown>>({
      include_docs: true,
    });
    let n = 0;
    let folders = 0;
    let skipped = 0;
    let sample: Record<string, unknown> | undefined;
    for (const row of res.rows) {
      const doc = row.doc as Record<string, unknown> | undefined;
      if (!doc) continue;
      const id = String(doc._id);
      const type = doc.type;
      // Skip design docs and chunk/leaf docs (they aren't files).
      if (id.startsWith("_design") || type === "leaf" || type === "chunkpack")
        continue;
      const path = doc.path;
      if (typeof path !== "string" || doc._deleted || doc.deleted) continue;

      if (type === "folder") {
        await this.ensureFolderExists(path);
        folders++;
        continue;
      }

      const content = await this.readRemoteContent(db, doc, v.passphrase);
      if (content === null) {
        skipped++;
        if (!sample) sample = doc;
        continue;
      }
      await this.writeToVault(path, content);
      n++;
    }
    if (n === 0 && skipped > 0 && sample) {
      logger.log(
        `Pull: skipped ${skipped} doc(s) this plugin can't read as text. ` +
          `Sample "${String(sample._id)}" fields: ${Object.keys(sample).join(", ")}`,
      );
    }
    // Pull succeeded → this remote state is now our base, so the next push is
    // allowed to build on it.
    this.settings.lastSeq[v.id] = String(info.update_seq);
    await this.persist();
    this.onStatus(
      "synced",
      `Pulled ${n} notes, ${folders} folders (server had ${res.rows.length} docs, skipped ${skipped}).`,
    );
    return n;
  }

  /**
   * Read a remote doc's content as text. Supports:
   *  - this plugin's own format (string `data`, optionally E2EE),
   *  - obsidian-livesync chunked text notes ("plain": children/eden -> leaves),
   *  - legacy inline notes ("notes": data string | string[]).
   * Returns null for anything it can't read as text (binary "newnote",
   * encrypted/compressed chunks, a missing chunk, or a wrong passphrase).
   */
  private async readRemoteContent(
    db: PouchDB.Database,
    doc: Record<string, unknown>,
    passphrase: string,
  ): Promise<string | null> {
    // This plugin's own doc (or an obsidian-livesync inline/HKDF data string).
    if (typeof doc.data === "string") {
      return await this.decryptPart(doc.data, passphrase, db);
    }
    // Legacy obsidian-livesync inline note.
    if (doc.type === "notes") {
      if (Array.isArray(doc.data)) return doc.data.join("");
      return typeof doc.data === "string" ? doc.data : null;
    }
    // obsidian-livesync chunked note. Only "plain" is text; "newnote" is
    // base64-encoded binary — skipped (text-only, deferred).
    if (doc.type !== "plain" || !Array.isArray(doc.children)) return null;

    const children = doc.children as string[];
    const eden = (doc.eden ?? {}) as Record<string, { data?: unknown }>;
    const missing = children.filter((id) => typeof eden[id]?.data !== "string");
    const leaves = new Map<string, string>();
    if (missing.length) {
      const chunkRes = await db.allDocs<{ data?: unknown }>({
        keys: missing,
        include_docs: true,
      });
      for (const row of chunkRes.rows) {
        if (!("doc" in row)) continue;
        const leaf = row.doc;
        if (leaf && typeof leaf.data === "string") leaves.set(row.id, leaf.data);
      }
    }
    const parts: string[] = [];
    for (const id of children) {
      const edenData = eden[id]?.data;
      // Each chunk is encrypted independently, so decrypt per-chunk then join.
      // (Joining first is what left "%=...%=..." ciphertext in the vault.)
      const raw =
        typeof edenData === "string" ? edenData : (leaves.get(id) ?? null);
      if (raw === null) return null; // a chunk is missing — can't assemble
      const part = await this.decryptPart(raw, passphrase, db);
      if (part === null) return null; // can't decrypt a chunk (wrong passphrase?)
      parts.push(part);
    }
    return parts.join("");
  }

  /**
   * Decrypt one stored data string back to text. Handles this plugin's own
   * format ("enc:" / plaintext passthrough) and obsidian-livesync's HKDF E2EE
   * ("%=", keyed by the remote's shared PBKDF2 salt). Returns null if the
   * remote uses OLS E2EE but has no salt doc we can read.
   */
  private async decryptPart(
    data: string,
    passphrase: string,
    db: PouchDB.Database,
  ): Promise<string | null> {
    try {
      if (data.startsWith(OLS_HKDF_PREFIX)) {
        const salt = await this.olsSalt(db);
        if (!salt) return null;
        return await decryptHKDF(data, passphrase, salt);
      }
      // ponytail: handles OLS HKDF ("%=") + this plugin's own format. Legacy OLS
      // PBKDF2 ("%" / "%~") not decoded — add if a pre-HKDF remote shows up.
      return await decryptString(data, passphrase);
    } catch {
      // Undecryptable (wrong passphrase / corrupt / unsupported) → skip this
      // doc, don't let a Web Crypto OperationError abort the whole pull.
      return null;
    }
  }

  /** Fetch & cache obsidian-livesync's shared PBKDF2 salt for `db`. */
  private async olsSalt(
    db: PouchDB.Database,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = db.name;
    const cached = this.olsSaltCache.get(key);
    if (cached !== undefined) return cached;
    let salt: Uint8Array<ArrayBuffer> | null = null;
    try {
      const doc = await db.get<{ pbkdf2salt?: string }>(
        "_local/obsidian_livesync_sync_parameters",
      );
      if (doc.pbkdf2salt) {
        const bin = atob(doc.pbkdf2salt);
        salt = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      }
    } catch {
      salt = null; // no sync-params doc → not an OLS-E2EE remote (or unreadable)
    }
    this.olsSaltCache.set(key, salt);
    return salt;
  }

  // ---- live continuous replication (local DB <-> default remote) -------

  private async startLive(): Promise<void> {
    const v = this.defaultVault;
    if (!v) return;
    const db = this.db();
    const remote = remoteDB(v) as PouchDB.Database<NoteDoc>;

    // Seed the local mirror, then watch it and reflect into the vault.
    this.changesHandler = db
      .changes({
        live: true,
        since: "now",
        include_docs: true,
        conflicts: true,
      })
      .on("change", (change) => void this.onLocalChange(change, v))
      .on("error", (e) => this.onStatus("error", String(e)));

    this.syncHandler = PouchDB.sync<NoteDoc>(db, remote, {
      live: true,
      retry: true,
    })
      .on("active", () => this.onStatus("syncing"))
      .on("paused", (err) => this.onStatus(err ? "error" : "synced"))
      .on("denied", (e) => this.onStatus("error", String(e)))
      .on("error", (e) => this.onStatus("error", String(e)));

    this.onStatus("syncing", "Live sync started.");
  }

  stopLive(): void {
    this.syncHandler?.cancel();
    this.changesHandler?.cancel();
    this.syncHandler = null;
    this.changesHandler = null;
  }

  private async onLocalChange(
    change: PouchDB.Core.ChangesResponseChange<NoteDoc>,
    v: RemoteVault,
  ): Promise<void> {
    try {
      if (change.deleted) {
        await this.trashVaultFile(change.id);
        return;
      }
      const doc = await this.resolveConflicts(change.id);
      if (!doc || doc._deleted || !doc.path) return;
      if (doc.type === "folder") {
        await this.ensureFolderExists(doc.path);
        return;
      }
      if (typeof doc.data !== "string") return;
      const content = await decryptString(doc.data, v.passphrase);
      await this.writeToVault(doc.path, content);
    } catch (e) {
      this.onStatus("error", String(e));
    }
  }

  // Last-write-wins by mtime: keep the newest revision, drop the losers.
  private async resolveConflicts(id: string): Promise<NoteDoc | null> {
    const db = this.db();
    let doc: NoteDoc & PouchDB.Core.GetMeta;
    try {
      doc = await db.get(id, { conflicts: true });
    } catch {
      return null;
    }
    const conflicts = doc._conflicts ?? [];
    if (!conflicts.length) return doc;
    const revs = [
      doc,
      ...(await Promise.all(conflicts.map((r) => db.get(id, { rev: r })))),
    ];
    revs.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    const [winner, ...losers] = revs;
    for (const l of losers) await db.remove(l._id, l._rev).catch(() => {});
    return winner;
  }

  // ---- vault event hooks (called from main.ts) -------------------------

  async handleUpsert(file: TFile): Promise<void> {
    if (!isSyncable(file)) return;
    if (this.syncHandler && this.defaultVault) {
      await this.upsertToLocal(file, this.defaultVault);
    } else {
      this.markDirty();
    }
  }

  async handleDelete(path: string): Promise<void> {
    if (this.syncHandler) {
      await this.deleteFromLocal(path);
    } else {
      this.markDirty();
    }
  }

  async handleRename(file: TFile, oldPath: string): Promise<void> {
    if (this.syncHandler && this.defaultVault) {
      await this.deleteFromLocal(oldPath);
      await this.upsertToLocal(file, this.defaultVault);
    } else {
      this.markDirty();
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.onStatus("dirty");
  }

  private async upsertToLocal(file: TFile, v: RemoteVault): Promise<void> {
    const db = this.db();
    const content = await this.app.vault.read(file);
    const existing = await db.get(file.path).catch(() => null);
    if (existing) {
      // Loop guard: if the stored content already matches, this change
      // originated from a remote doc we just reflected — skip the echo.
      const current = await decryptString(existing.data, v.passphrase);
      if (current === content) return;
    }
    await db.put({
      _id: file.path,
      _rev: existing?._rev,
      path: file.path,
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      type: "plain",
      data: await encryptString(content, v.passphrase),
    });
  }

  private async deleteFromLocal(path: string): Promise<void> {
    const db = this.db();
    const existing = await db.get(path).catch(() => null);
    if (existing) await db.remove(existing._id, existing._rev).catch(() => {});
  }

  // ---- vault write helpers --------------------------------------------

  private async writeToVault(path: string, content: string): Promise<void> {
    const p = normalizePath(path);
    const af = this.app.vault.getAbstractFileByPath(p);
    if (af instanceof TFile) {
      const current = await this.app.vault.read(af);
      if (current !== content) await this.app.vault.modify(af, content);
      return;
    }
    await this.ensureParentFolder(p);
    await this.app.vault.create(p, content);
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const p = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
    await this.app.vault.createFolder(p).catch(() => {});
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const dir = path.split("/").slice(0, -1).join("/");
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
    await this.app.vault.createFolder(dir).catch(() => {});
  }

  private async trashVaultFile(path: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (af) await this.app.fileManager.trashFile(af).catch(() => {});
  }
}
