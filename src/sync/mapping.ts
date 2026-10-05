// Mapping between vault files and CouchDB documents.
import type { TFile } from "obsidian";

export interface NoteDoc {
  _id: string; // = vault-relative path
  _rev?: string;
  path: string;
  mtime: number;
  ctime: number;
  type: "plain" | "folder"; // "folder" = empty-folder marker (data is "")
  data: string; // note content (ciphertext when E2EE is on); "" for folders
  _deleted?: boolean;
}

// ponytail: text files only for now. Binary (images, PDFs) is deferred —
// it needs CouchDB attachments. Add those extensions when binary is wanted.
const TEXT_EXTS = new Set([
  "md",
  "txt",
  "json",
  "css",
  "canvas",
  "html",
  "csv",
  "svg",
  "xml",
  "yml",
  "yaml",
]);

export function isSyncable(file: TFile): boolean {
  return TEXT_EXTS.has(file.extension.toLowerCase());
}

export function docIdForPath(path: string): string {
  return path;
}
