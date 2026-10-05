import { Plugin, TFile, Notice, type TAbstractFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type LiveSyncSettings,
  type RemoteVault,
  getDefaultVault,
} from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/engine";
import { VaultChooserModal } from "./ui/VaultChooserModal";
import { DuckumentsSettingTab } from "./ui/SettingsTab";
import { LogView, LOG_VIEW_TYPE } from "./ui/LogView";
import { logger } from "./log";

const STATUS: Record<SyncStatus, { icon: string; cls: string; label: string }> =
  {
    off: { icon: "⊘", cls: "", label: "LiveSync idle" },
    synced: {
      icon: "✓",
      cls: "duckuments-status-ok",
      label: "All changes synced",
    },
    dirty: {
      icon: "↑",
      cls: "duckuments-status-dirty",
      label: "Local changes not pushed",
    },
    syncing: { icon: "↻", cls: "", label: "Syncing…" },
    error: { icon: "✗", cls: "duckuments-status-error", label: "Sync error" },
  };
const STATUS_CLASSES = Object.values(STATUS)
  .map((s) => s.cls)
  .filter(Boolean);

export default class DuckumentsLiveSync extends Plugin {
  settings!: LiveSyncSettings;
  engine!: SyncEngine;
  private statusEl!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.engine = new SyncEngine(this.app, (s, m) => this.renderStatus(s, m));
    this.renderStatus("off");

    this.addSettingTab(new DuckumentsSettingTab(this.app, this));
    this.registerView(LOG_VIEW_TYPE, (leaf) => new LogView(leaf));

    this.addCommand({
      id: "show-logs",
      name: "Show logs",
      callback: () => this.showLogs(),
    });
    this.addCommand({
      id: "push",
      name: "Push: send local changes to the default remote",
      callback: () => this.withDefault((v) => this.engine.pushTo(v)),
    });
    this.addCommand({
      id: "pull",
      name: "Pull: get changes from the default remote",
      callback: () => this.withDefault((v) => this.engine.pullFrom(v)),
    });
    this.addCommand({
      id: "push-from",
      name: "Push from… (choose remote vault)",
      callback: () => this.chooseThen("Push", (v) => this.engine.pushTo(v)),
    });
    this.addCommand({
      id: "pull-from",
      name: "Pull from… (choose remote vault)",
      callback: () => this.chooseThen("Pull", (v) => this.engine.pullFrom(v)),
    });
    this.addCommand({
      id: "toggle-live",
      name: "Toggle live sync",
      callback: () => this.toggleLive(),
    });

    // Register vault events after layout is ready so the initial file scan
    // doesn't fire a storm of "create" events.
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      void this.engine.configure(
        getDefaultVault(this.settings),
        this.settings.liveSync,
      );
      if (this.settings.syncOnStartup)
        void this.withDefault((v) => this.engine.pullFrom(v));
    });
  }

  onunload(): void {
    this.engine?.destroy();
  }

  private registerVaultEvents(): void {
    const upsert = (f: TAbstractFile) => {
      if (f instanceof TFile) this.run(this.engine.handleUpsert(f));
    };
    this.registerEvent(this.app.vault.on("create", upsert));
    this.registerEvent(this.app.vault.on("modify", upsert));
    this.registerEvent(
      this.app.vault.on("delete", (f) =>
        this.run(this.engine.handleDelete(f.path)),
      ),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile) this.run(this.engine.handleRename(f, oldPath));
      }),
    );
  }

  private run(p: Promise<unknown>): void {
    p.catch((e) => {
      logger.log("ERROR: " + String(e));
      new Notice("LiveSync: " + String(e));
    });
  }

  private async showLogs(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(LOG_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: LOG_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  private async withDefault(
    fn: (v: RemoteVault) => Promise<unknown>,
  ): Promise<void> {
    const v = getDefaultVault(this.settings);
    if (!v) {
      new Notice("No remote configured. Add one in settings.");
      return;
    }
    try {
      await fn(v);
    } catch (e) {
      logger.log("ERROR: " + String(e));
      new Notice("LiveSync: " + String(e));
    }
  }

  private chooseThen(
    action: string,
    fn: (v: RemoteVault) => Promise<unknown>,
  ): void {
    if (!this.settings.vaults.length) {
      new Notice("No remotes configured. Add one in settings.");
      return;
    }
    new VaultChooserModal(this.app, this.settings.vaults, action, (v) =>
      this.run(fn(v)),
    ).open();
  }

  private async toggleLive(): Promise<void> {
    this.settings.liveSync = !this.settings.liveSync;
    await this.saveSettings();
    new Notice(
      "Live sync " + (this.settings.liveSync ? "enabled" : "disabled"),
    );
  }

  renderStatus(s: SyncStatus, msg?: string): void {
    const st = STATUS[s];
    this.statusEl.setText(`${st.icon} LiveSync`);
    this.statusEl.removeClasses(STATUS_CLASSES);
    if (st.cls) this.statusEl.addClass(st.cls);
    this.statusEl.setAttribute("aria-label", msg ?? st.label);
    this.statusEl.title = msg ?? st.label;
    if (msg || s === "error") logger.log(`[${s}] ${msg ?? st.label}`);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.engine?.configure(
      getDefaultVault(this.settings),
      this.settings.liveSync,
    );
  }
}
