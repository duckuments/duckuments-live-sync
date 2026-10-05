// Settings types and defaults for Duckuments LiveSync.

export interface RemoteVault {
  id: string; // local uuid, stable key
  name: string; // friendly label shown in UI / choosers
  couchURI: string; // e.g. https://couch.example.com:6984
  username: string;
  password: string;
  dbName: string;
  passphrase: string; // E2EE passphrase; "" disables encryption
}

export interface LiveSyncSettings {
  vaults: RemoteVault[];
  defaultVaultId: string | null;
  liveSync: boolean; // continuous replication with the default vault
  syncOnStartup: boolean; // pull from the default remote once on load
  // Last remote update_seq we saw per vault id (the "base" for pull-before-push).
  lastSeq: Record<string, string>;
}

export const DEFAULT_SETTINGS: LiveSyncSettings = {
  vaults: [],
  defaultVaultId: null,
  liveSync: false,
  syncOnStartup: false,
  lastSeq: {},
};

export function newVault(): RemoteVault {
  return {
    id: crypto.randomUUID(),
    name: "New remote",
    couchURI: "",
    username: "",
    password: "",
    dbName: "",
    passphrase: "",
  };
}

export function getDefaultVault(s: LiveSyncSettings): RemoteVault | null {
  return s.vaults.find((v) => v.id === s.defaultVaultId) ?? s.vaults[0] ?? null;
}
