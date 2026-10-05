// Self-check for share.ts parsing. Run: `bun src/share.test.ts`
// (pure functions, no Obsidian import). Not part of the plugin bundle.
import assert from "node:assert/strict";
import { ensureSlug, titleOf } from "./share";

// reuse an existing valid slug, no rewrite
{
  const src = "---\nslug: keep-me\ntitle: X\n---\nbody";
  const r = ensureSlug(src);
  assert.equal(r.slug, "keep-me");
  assert.equal(r.text, src);
}
// frontmatter without slug -> injected, slug valid, rest preserved
{
  const r = ensureSlug("---\ntitle: X\n---\nbody");
  assert.match(r.slug, /^[a-z0-9]{1,128}$/);
  assert.ok(r.text.includes(`slug: ${r.slug}`));
  assert.ok(r.text.includes("title: X") && r.text.endsWith("body"));
}
// no frontmatter -> new block prepended
{
  const r = ensureSlug("# Hello\ntext");
  assert.ok(r.text.startsWith(`---\nslug: ${r.slug}\n---\n\n# Hello`));
}
// invalid slug value -> replaced
{
  const r = ensureSlug("---\nslug: has spaces\n---\nx");
  assert.notEqual(r.slug, "has");
  assert.match(r.slug, /^[a-z0-9]+$/);
}
// title: frontmatter > filename fallback
assert.equal(titleOf('---\ntitle: "My Note"\n---\n', "a/b.md"), "My Note");
assert.equal(titleOf("# no fm\n", "a/b/the-file.md"), "the-file");

console.log("share self-check ok");
