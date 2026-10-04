// React settings UI: manage multiple remote vaults.
import { App, PluginSettingTab, Notice } from "obsidian";
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type DuckumentsLiveSync from "../main";
import { type LiveSyncSettings, type RemoteVault, newVault } from "../settings";
import { testConnection } from "../api/routes";

export class DuckumentsSettingTab extends PluginSettingTab {
    private root: Root | null = null;

    constructor(
        app: App,
        private plugin: DuckumentsLiveSync
    ) {
        super(app, plugin);
    }

    display(): void {
        this.root = createRoot(this.containerEl);
        this.root.render(
            <StrictMode>
                <SettingsView plugin={this.plugin} />
            </StrictMode>
        );
    }

    hide(): void {
        this.root?.unmount();
        this.root = null;
        this.containerEl.empty();
    }
}

function SettingsView({ plugin }: { plugin: DuckumentsLiveSync }) {
    const [settings, setLocal] = useState<LiveSyncSettings>({ ...plugin.settings });

    const save = async (next: LiveSyncSettings) => {
        plugin.settings = next;
        setLocal({ ...next });
        await plugin.saveSettings();
    };

    const effectiveDefault = settings.defaultVaultId ?? settings.vaults[0]?.id ?? null;

    const updateVault = (id: string, patch: Partial<RemoteVault>) =>
        save({ ...settings, vaults: settings.vaults.map((v) => (v.id === id ? { ...v, ...patch } : v)) });

    const addVault = () => {
        const v = newVault();
        save({
            ...settings,
            vaults: [...settings.vaults, v],
            defaultVaultId: settings.defaultVaultId ?? v.id,
        });
    };

    const removeVault = (id: string) => {
        const vaults = settings.vaults.filter((v) => v.id !== id);
        save({
            ...settings,
            vaults,
            defaultVaultId: settings.defaultVaultId === id ? (vaults[0]?.id ?? null) : settings.defaultVaultId,
        });
    };

    return (
        <div>
            <h2>Duckuments LiveSync</h2>

            <div className="duckuments-field">
                <label>Live sync</label>
                <input
                    type="checkbox"
                    checked={settings.liveSync}
                    onChange={(e) => save({ ...settings, liveSync: e.target.checked })}
                />
                <span className="setting-item-description">
                    Continuously sync with the default remote vault.
                </span>
            </div>

            {settings.vaults.length === 0 && (
                <p className="setting-item-description">No remote vaults yet. Add one below.</p>
            )}

            {settings.vaults.map((v) => (
                <VaultCard
                    key={v.id}
                    v={v}
                    isDefault={v.id === effectiveDefault}
                    onChange={(patch) => updateVault(v.id, patch)}
                    onDefault={() => save({ ...settings, defaultVaultId: v.id })}
                    onRemove={() => removeVault(v.id)}
                />
            ))}

            <button onClick={addVault}>+ Add remote vault</button>
        </div>
    );
}

interface VaultCardProps {
    v: RemoteVault;
    isDefault: boolean;
    onChange: (patch: Partial<RemoteVault>) => void;
    onDefault: () => void;
    onRemove: () => void;
}

function VaultCard({ v, isDefault, onChange, onDefault, onRemove }: VaultCardProps) {
    const [testing, setTesting] = useState(false);

    const field = (label: string, key: keyof RemoteVault, type = "text") => (
        <div className="duckuments-field">
            <label>{label}</label>
            <input type={type} value={v[key]} onChange={(e) => onChange({ [key]: e.target.value })} />
        </div>
    );

    const test = async () => {
        setTesting(true);
        const r = await testConnection(v);
        new Notice(r.message);
        setTesting(false);
    };

    return (
        <div className={"duckuments-vault-card" + (isDefault ? " is-default" : "")}>
            <h4>
                {v.name || "(unnamed)"}
                {isDefault && <span className="duckuments-badge">default</span>}
            </h4>
            {field("Name", "name")}
            {field("Server URL", "couchURI")}
            {field("Database", "dbName")}
            {field("Username", "username")}
            {field("Password", "password", "password")}
            {field("Passphrase (E2EE)", "passphrase", "password")}
            <div className="duckuments-card-actions">
                {!isDefault && <button onClick={onDefault}>Set default</button>}
                <button onClick={test} disabled={testing}>
                    {testing ? "Testing…" : "Test connection"}
                </button>
                <button className="mod-warning" onClick={onRemove}>
                    Remove
                </button>
            </div>
        </div>
    );
}
