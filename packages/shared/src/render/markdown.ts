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
 * Removes anything a draft placed above the H1.
 *
 * The body starts at the H1 — every prompt says so, and the assembler,
 * the preview and every export assume it. What kept turning up above it was
 * publishing apparatus the model had no business writing: YAML front matter,
 * an "on-page mechanics" HTML comment, and most recently a blockquote headed
 * "Metadatos para la etapa de publicación" carrying the title tag, slug and
 * meta description.
 *
 * The root cause of those is fixed elsewhere — the review used to be told the
 * meta description was empty, so it wrote one into the only place it could
 * reach. This is the backstop, and it is the general form of the rule rather
 * than a pattern per language: content before the first heading is not content.
 *
 * A body with no H1 at all is left alone. Deleting everything from an article
 * that merely forgot its heading would be worse than the thing being fixed.
 */
export function stripBeforeH1(markdown: string): string {
  const match = /^#[ \t]+\S/m.exec(markdown);
  if (!match || match.index === 0) return markdown;

  const preamble = markdown.slice(0, match.index);
  // A lead written above the heading is a mistake worth keeping; apparatus is
  // not. Blockquotes and metadata-shaped lines go, real prose stays.
  const isApparatus = preamble
    .split("\n")
    .filter((line) => line.trim())
    .every((line) => /^\s*(>|\*\*|-{3,}|[A-Za-z_][\w.-]*\s*:)/.test(line.trim()));

  return isApparatus ? markdown.slice(match.index) : markdown;
}

/**
 * Removes HTML the draft stage had no business writing.
 *
 * A draft came back as an agency deliverable rather than a body: three
 * `<img src="/img/….webp">` tags at paths that exist nowhere, an
 * "on-page mechanics" HTML comment carrying the title tag, slug and meta
 * description, and a `<script type="application/ld+json">` block. Every one of
 * those duplicates a later stage — `produceImages`, the meta stage,
 * `buildJsonLd` — so none of it is content, and all of it outranked the real
 * thing: the invented images rendered as empty boxes, and the review reported
 * a zero-length meta description because the only copy was inside a comment.
 *
 * Nothing downstream could see it either. Image handling in this system
 * matches Markdown `![alt](url)` and nothing else, so an `<img>` tag is
 * invisible to placement, to the strip, to the count and to the export.
 *
 * `<script>` is the one that is not merely untidy: `markdownToHtml` passes raw
 * HTML through, the result is stored as `bodyHtml` and rendered with
 * `dangerouslySetInnerHTML`, and the stage that writes it has just been
 * reading live pages off the SERP.
 */
export function stripAuthoredHtml(markdown: string): string {
  return (
    markdown
      // Script and style, opening tag through closing tag, contents included.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      // An unterminated one still must not survive.
      .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<img\b[^>]*>/gi, "")
      // Blank lines left where a block was.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Whether a body carries any of it — for the check that reports it. */
export function findAuthoredHtml(markdown: string): string[] {
  const found: string[] = [];
  if (/<img\b/i.test(markdown)) found.push("<img>");
  if (/<script\b/i.test(markdown)) found.push("<script>");
  if (/<style\b/i.test(markdown)) found.push("<style>");
  if (/<!--/.test(markdown)) found.push("HTML comment");
  return found;
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
