import { Marked } from "marked";

/**
 * Markdown → HTML for the editor, the preview and the HTML export.
 *
 * A fresh `Marked` instance rather than the module-level singleton, so options
 * set here cannot leak into another caller's rendering.
 */
const marked = new Marked({
  gfm: true,
  breaks: false,
});

/**
 * Removes a YAML front-matter block from the top of a body.
 *
 * The draft stage is told to start at the H1, and one run started at
 * `---\ntitle: "…"\n---` instead. The renderer has no notion of front matter, so
 * the preview and every HTML export printed `title: "…" description: "…"` as
 * prose above the heading. `leadParagraph` skips such a block already, which is
 * why the scores looked fine while the article read as broken.
 *
 * Only a block at the very start is a front matter. A `---` further down is a
 * thematic break and belongs to the article.
 */
export function stripFrontMatter(markdown: string): string {
  const match = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    markdown,
  );
  if (!match) return markdown;

  // An article may legitimately open on a thematic break, and a second `---`
  // further down would then close a block that was never front matter. So the
  // contents have to look like front matter: `key: value` lines, no prose.
  const lines = (match[1] ?? "").split("\n").filter((line) => line.trim());

  // A key at the top level, a list item, or an indented continuation of the
  // line above. Anything else — a sentence, a heading — means this is article
  // text between two thematic breaks, and it stays.
  const isYamlLine = (line: string): boolean =>
    /^\s/.test(line) || /^(?:[A-Za-z_][\w.-]*\s*:|-\s+\S)/.test(line);

  const looksLikeYaml =
    lines.length > 0 &&
    lines.some((line) => /^[A-Za-z_][\w.-]*\s*:/.test(line)) &&
    lines.every(isYamlLine);

  if (!looksLikeYaml) return markdown;

  return markdown.slice(match[0].length).replace(/^\s*\n/, "");
}

/**
 * Images are rendered as figures with captions.
 *
 * The convention the article pipeline emits is an image followed by an
 * italic-only line, which is the caption for that image. Rendering that as a
 * real `<figure>/<figcaption>` matters for both accessibility and how the
 * markup reads to a crawler.
 */
function wrapFigures(html: string): string {
  return html.replace(
    /<p>(<img[^>]*>)<\/p>\s*<p><em>(.*?)<\/em><\/p>/gs,
    (_match, img: string, caption: string) =>
      `<figure>${img}<figcaption>${caption}</figcaption></figure>`,
  );
}

/** Adds loading and decoding hints; the hero is overridden by the caller. */
function addImageHints(html: string): string {
  return html.replace(
    /<img((?:(?!loading=)[^>])*)>/g,
    '<img$1 loading="lazy" decoding="async">',
  );
}

export function markdownToHtml(markdown: string): string {
  const raw = marked.parse(markdown, { async: false });
  return addImageHints(wrapFigures(raw));
}

/**
 * Renders the article for export: HTML plus the JSON-LD blocks inline, so the
 * exported file is a complete, paste-ready page section.
 */
export function renderExportHtml(input: {
  title: string;
  titleTag?: string | null;
  metaDescription?: string | null;
  bodyMdx: string;
  jsonLd?: unknown[];
}): string {
  const body = markdownToHtml(input.bodyMdx);
  const schema =
    input.jsonLd && input.jsonLd.length > 0
      ? input.jsonLd
          .map(
            (block) =>
              `<script type="application/ld+json">\n${JSON.stringify(block, null, 2)}\n</script>`,
          )
          .join("\n")
      : "";

  return [
    `<!-- title: ${escapeHtml(input.titleTag ?? input.title)} -->`,
    input.metaDescription
      ? `<!-- meta description: ${escapeHtml(input.metaDescription)} -->`
      : "",
    schema,
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collects every image URL in the body — used to build the export archive. */
export function extractImageUrls(
  markdown: string,
): { url: string; alt: string }[] {
  const out: { url: string; alt: string }[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    if (match[2]) out.push({ url: match[2], alt: match[1] ?? "" });
  }
  return out;
}
