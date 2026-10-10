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
- **Public preview** — share a read-only web page of a single note with **Copy public link**. Publishes a plaintext snapshot that the separate [live-note-preview](https://github.com/duckuments/live-note-preview-obsidian) viewer renders at a stable URL.

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

| Field               | Example                                 |
| ------------------- | --------------------------------------- |
| Name                | `My Couch`                              |
| CouchDB URL         | `https://couch.example.com:6984`        |
| Username / Password | your CouchDB credentials                |
| Database            | `my_vault`                              |
| Passphrase          | E2EE passphrase (blank = no encryption) |

Set one remote as the default, then toggle **Live sync** on, or use the commands below.

## Commands

- **Push** — send local changes to the default remote
- **Pull** — get changes from the default remote
- **Push from… / Pull from…** — choose which remote
- **Toggle live sync**
- **Show logs**
- **Copy public link for the active note** — publish the current note and copy its public URL

## Public preview (share a note)

The **Copy public link for the active note** command publishes the current note as a public web page and copies its URL to your clipboard.

- A `slug` is written into the note's frontmatter (or reused if already present), so the link stays the same every time you re-publish: `https://obsidian.loonielabs.net/r/<slug>`.
- It writes a `pub:<slug>` snapshot document to your **default** remote holding the note's plaintext markdown and title.
- A separate viewer app ([live-note-preview](https://github.com/duckuments/live-note-preview-obsidian)) serves `/r/<slug>`: its backend reads `pub:<slug>` from CouchDB (credentials stay server-side) and the page renders the markdown with a live table of contents.

> ⚠️ **Published snapshots are not encrypted.** Unlike synced notes, the snapshot is stored as plaintext so the viewer can read it without your passphrase. Anyone with the link can read the note. The slug is unguessable but the page is not access-controlled.

It's a snapshot, not a live mirror — re-run the command to update the published copy. There's no "unpublish" command yet; delete the `pub:<slug>` document from CouchDB to take a note down.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # typecheck + production build
```

For local testing, copy `.env.example` to `.env` and set `PATHS_TEST_INSTALL` to your vault's plugin folder. The build copies `main.js` / `manifest.json` / `styles.css` there. Separate multiple paths with `:` (Unix) or `;` (Windows).

## License

MIT
