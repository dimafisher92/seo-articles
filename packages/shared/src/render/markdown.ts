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
