// Public-link sharing: slug handling and title extraction.

// ponytail: the viewer host is fixed. Promote to a plugin setting only if you
// deploy the viewer somewhere other than this host.
export const BASE_URL = "https://obsidian.loonielabs.net";

const SLUG_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const randomSlug = (): string => Math.random().toString(36).slice(2, 8);

/** Reuse the note's frontmatter `slug` (stable links) or inject a fresh one. */
export function ensureSlug(text: string): { slug: string; text: string } {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const existing = fm[1].match(/^slug:\s*(\S+)\s*$/m);
    if (existing && SLUG_RE.test(existing[1])) return { slug: existing[1], text };
    const slug = randomSlug();
    return { slug, text: text.replace(/^---\n/, `---\nslug: ${slug}\n`) };
  }
  const slug = randomSlug();
  return { slug, text: `---\nslug: ${slug}\n---\n\n${text}` };
}

export function titleOf(text: string, path: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const t = fm?.[1].match(/^title:\s*(.+?)\s*$/m);
  if (t) return t[1].replace(/^["']|["']$/g, "");
  return path.replace(/\.md$/, "").split("/").pop() ?? path;
}
