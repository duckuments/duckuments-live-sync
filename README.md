# Duckuments LiveSync

Minimal self-hosted [CouchDB](https://couchdb.apache.org/) live sync for your [Obsidian](https://obsidian.md) vault, with end-to-end encryption and multiple remote vaults.

It keeps your notes in your own CouchDB instead of a third-party service. Notes are encrypted on your machine before they ever leave it, so the server only stores opaque ciphertext.

## Features

- **Live sync** — continuous replication with your default remote, plus a status-bar indicator (idle / synced / dirty / syncing / error).
- **Manual push & pull** — one-off sync with the default remote, or pick any configured remote.
- **Multiple remotes** — configure several CouchDB vaults, each with its own URL, credentials, database, and passphrase.
- **End-to-end encryption** — AES-GCM with a PBKDF2-derived key (200k iterations). Passphrase stays local; leave it blank to disable.
- **obsidian-livesync interop** — can read notes written by [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync), decrypting its HKDF-chunked documents on pull.
- **Log view** — in-app command to watch what the plugin is doing.

## How it works

- **Push / pull** operate directly between a vault file and the chosen remote, re-encrypting with that remote's passphrase. This is what makes multiple remotes + E2EE work without a transform layer.
- **Live sync** mirrors a local [PouchDB](https://pouchdb.com/) with the default remote (both holding ciphertext), then reflects changes into the vault.

Only text files sync for now (`md`, `txt`, `json`, `css`, `canvas`, `html`, `csv`, `svg`, `xml`, `yml`, `yaml`). Binary files (images, PDFs) need CouchDB attachments and aren't supported yet. Note content is encrypted; the file path is not.

## Install (manual)

1. Build the plugin (see below), or grab `main.js`, `manifest.json`, and `styles.css` from a release.
2. Copy those three files into `<your-vault>/.obsidian/plugins/duckuments-live-sync/`.
3. Enable **Duckuments LiveSync** in Obsidian → Settings → Community plugins.

## Configure

Open the plugin's settings tab and add a remote vault:

| Field | Example |
|-------|---------|
| Name | `My Couch` |
| CouchDB URL | `https://couch.example.com:6984` |
| Username / Password | your CouchDB credentials |
| Database | `my_vault` |
| Passphrase | E2EE passphrase (blank = no encryption) |

Set one remote as the default, then toggle **Live sync** on, or use the commands below.

## Commands

- **Push** — send local changes to the default remote
- **Pull** — get changes from the default remote
- **Push from… / Pull from…** — choose which remote
- **Toggle live sync**
- **Show logs**

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # typecheck + production build
```

For local testing, copy `.env.example` to `.env` and set `PATHS_TEST_INSTALL` to your vault's plugin folder. The build copies `main.js` / `manifest.json` / `styles.css` there. Separate multiple paths with `:` (Unix) or `;` (Windows).

## License

MIT
