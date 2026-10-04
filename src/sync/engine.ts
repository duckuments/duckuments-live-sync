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
import type { RemoteVault } from "../settings";
import { remoteDB } from "../api/routes";
import { encryptString, decryptString } from "../api/encryption";
import { isSyncable, type NoteDoc } from "./mapping";

export type SyncStatus = "off" | "synced" | "dirty" | "syncing" | "error";

export class SyncEngine {
  private localDB: PouchDB.Database<NoteDoc> | null = null;
  private syncHandler: PouchDB.Replication.Sync<NoteDoc> | null = null;
  private changesHandler: PouchDB.Core.Changes<NoteDoc> | null = null;
  private defaultVault: RemoteVault | null = null;
  private dirty = false;

  constructor(
    private app: App,
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
    const files = this.app.vault.getFiles().filter(isSyncable);
    const existing = await db.allDocs({ keys: files.map((f) => f.path) });
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
    if (docs.length) await db.bulkDocs(docs as NoteDoc[]);
    // ponytail: push upserts present files; it does not delete remote docs
    // for locally-removed files. Live sync handles deletions.
    this.dirty = false;
    this.onStatus(
      this.syncHandler ? "synced" : "synced",
      `Pushed ${docs.length} notes.`,
    );
    return docs.length;
  }

  /** Download every doc from `v` into the vault. */
  async pullFrom(v: RemoteVault): Promise<number> {
    this.onStatus("syncing", `Pulling from "${v.name}"...`);
    const db = remoteDB(v);
    const res = await db.allDocs<NoteDoc>({ include_docs: true });
    let n = 0;
    for (const row of res.rows) {
      const doc = row.doc;
      if (!doc || !doc.path || doc._deleted) continue;
      const content = await decryptString(doc.data, v.passphrase);
      await this.writeToVault(doc.path, content);
      n++;
    }
    this.onStatus("synced", `Pulled ${n} notes.`);
    return n;
  }

  // ---- live continuous replication (local DB <-> default remote) -------

  private async startLive(): Promise<void> {
    const v = this.defaultVault;
    if (!v) return;
    const db = this.db();
    const remote = remoteDB(v);

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
      if (!doc || doc._deleted) return;
      const content = await decryptString(doc.data, v.passphrase);
      await this.writeToVault(doc.path, content);
    } catch (e) {
      this.onStatus("error", String(e));
    }
  }

  // Last-write-wins by mtime: keep the newest revision, drop the losers.
  private async resolveConflicts(id: string): Promise<NoteDoc | null> {
    const db = this.db();
    let doc: NoteDoc;
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
    for (const l of losers) await db.remove(l._id, l._rev!).catch(() => {});
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
    if (existing) await db.remove(existing._id, existing._rev!).catch(() => {});
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

  private async ensureParentFolder(path: string): Promise<void> {
    const dir = path.split("/").slice(0, -1).join("/");
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
    await this.app.vault.createFolder(dir).catch(() => {});
  }

  private async trashVaultFile(path: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (af) await this.app.vault.trash(af, false).catch(() => {});
  }
}
