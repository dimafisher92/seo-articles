import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { eq } from "drizzle-orm";
import JSZip from "jszip";

import { articleImages, articles, clients } from "@seo/db";
import {
  extractImageUrls,
  renderExportHtml,
  slugify,
} from "@seo/shared";

import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** The zip export downloads every image; that can outrun the default budget. */
export const maxDuration = 120;

type Format = "md" | "html" | "docx" | "zip";

/**
 * Exports a finished article.
 *
 * The client publishes wherever they publish, so the job here is to hand over
 * something complete and paste-ready rather than to integrate with a CMS:
 * Markdown for a headless setup, HTML with the JSON-LD inline, DOCX for review,
 * or a zip with the images and a metadata file alongside.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await currentUser())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const format = (new URL(request.url).searchParams.get("format") ??
    "md") as Format;

  const [article] = await db()
    .select()
    .from(articles)
    .where(eq(articles.id, id))
    .limit(1);
  if (!article) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const body = article.bodyMdx ?? "";
  const base = slugify(article.slug ?? article.title) || "article";

  switch (format) {
    case "md":
      return download(
        buildMarkdown(article.title, article, body),
        `${base}.md`,
        "text/markdown; charset=utf-8",
      );

    case "html":
      return download(
        renderExportHtml({
          title: article.title,
          titleTag: article.titleTag,
          metaDescription: article.metaDescription,
          bodyMdx: body,
          jsonLd: article.jsonLd,
        }),
        `${base}.html`,
        "text/html; charset=utf-8",
      );

    case "docx": {
      const buffer = await buildDocx(article.title, body);
      return download(
        buffer,
        `${base}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }

    case "zip": {
      const buffer = await buildZip(id, article, body, base);
      return download(buffer, `${base}.zip`, "application/zip");
    }

    default:
      return Response.json({ error: "unknown format" }, { status: 400 });
  }
}

function download(
  content: string | Buffer | Uint8Array,
  filename: string,
  contentType: string,
): Response {
  const payload =
    typeof content === "string" ? content : new Uint8Array(content);

  return new Response(payload as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

/** Front matter carries the metadata a static-site build would need. */
function buildMarkdown(
  title: string,
  article: typeof articles.$inferSelect,
  body: string,
): string {
  const escape = (value: string): string => value.replace(/"/g, '\\"');

  const frontMatter = [
    "---",
    `title: "${escape(title)}"`,
    article.titleTag ? `titleTag: "${escape(article.titleTag)}"` : "",
    article.metaDescription
      ? `description: "${escape(article.metaDescription)}"`
      : "",
    article.slug ? `slug: "${article.slug}"` : "",
    article.mainKeyword ? `mainKeyword: "${escape(article.mainKeyword)}"` : "",
    article.secondaryKeywords.length > 0
      ? `secondaryKeywords: [${article.secondaryKeywords.map((k) => `"${escape(k)}"`).join(", ")}]`
      : "",
    `wordCount: ${article.wordCount ?? 0}`,
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${frontMatter}\n${body}`;
}

/**
 * Renders the Markdown into a Word document.
 *
 * Handles the structures the article pipeline actually emits — headings, list
 * items, images-as-placeholders and paragraphs with inline links. A general
 * Markdown-to-DOCX conversion is not the goal; this file is for review and
 * sign-off, and the HTML and Markdown exports carry the exact markup.
 */
async function buildDocx(title: string, body: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];

  const withoutH1 = body.replace(/^#\s+.*$/m, "").trim();

  for (const block of withoutH1.split(/\n\s*\n/)) {
    const chunk = block.trim();
    if (!chunk) continue;

    const heading = /^(#{2,4})\s+(.*)$/.exec(chunk);
    if (heading?.[1] && heading[2]) {
      paragraphs.push(
        new Paragraph({
          text: stripInline(heading[2]),
          heading:
            heading[1].length === 2
              ? HeadingLevel.HEADING_1
              : heading[1].length === 3
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
        }),
      );
      continue;
    }

    // A standalone image becomes a placeholder line; the real files ship in
    // the zip export, and a reviewer only needs to know one belongs here.
    const image = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(chunk);
    if (image) {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: `[image: ${image[1] || "no alt text"}]`,
              italics: true,
              color: "888888",
            }),
          ],
        }),
      );
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(chunk)) {
      for (const line of chunk.split("\n")) {
        const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
        if (item?.[1]) {
          paragraphs.push(
            new Paragraph({
              text: stripInline(item[1]),
              bullet: { level: 0 },
            }),
          );
        }
      }
      continue;
    }

    paragraphs.push(new Paragraph({ text: stripInline(chunk) }));
  }

  const document = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(document);
}

/** Flattens inline Markdown to plain text for the DOCX renderer. */
function stripInline(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\n/g, " ")
    .trim();
}

async function buildZip(
  articleId: string,
  article: typeof articles.$inferSelect,
  body: string,
  base: string,
): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(`${base}.md`, buildMarkdown(article.title, article, body));
  zip.file(
    `${base}.html`,
    renderExportHtml({
      title: article.title,
      titleTag: article.titleTag,
      metaDescription: article.metaDescription,
      bodyMdx: body,
      jsonLd: article.jsonLd,
    }),
  );

  const [client] = await db()
    .select({ name: clients.name, domain: clients.domain })
    .from(clients)
    .where(eq(clients.id, article.clientId))
    .limit(1);

  zip.file(
    "metadata.json",
    JSON.stringify(
      {
        client: client?.name,
        domain: client?.domain,
        title: article.title,
        titleTag: article.titleTag,
        metaDescription: article.metaDescription,
        slug: article.slug,
        mainKeyword: article.mainKeyword,
        secondaryKeywords: article.secondaryKeywords,
        wordCount: article.wordCount,
        readingTimeMinutes: article.readingTimeMinutes,
        faq: article.faq,
        internalLinks: article.internalLinks,
        externalSources: article.externalSources,
        seoScore: article.seoScore,
        jsonLd: article.jsonLd,
      },
      null,
      2,
    ),
  );

  const stored = await db()
    .select()
    .from(articleImages)
    .where(eq(articleImages.articleId, articleId));

  const altByUrl = new Map(
    stored
      .filter((image) => image.blobUrl)
      .map((image) => [image.blobUrl as string, image.altText ?? ""]),
  );

  const folder = zip.folder("images");
  const manifest: { file: string; alt: string; url: string }[] = [];

  // Only images that survived into the body are exported, so a failed or
  // replaced render does not ship alongside the copy that replaced it.
  for (const [index, image] of extractImageUrls(body).entries()) {
    try {
      const response = await fetch(image.url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;

      const extension =
        response.headers.get("content-type")?.split("/")[1]?.split(";")[0] ??
        "png";
      const filename = `${String(index + 1).padStart(2, "0")}-${base}.${extension}`;

      folder?.file(filename, await response.arrayBuffer());
      manifest.push({
        file: filename,
        alt: image.alt || altByUrl.get(image.url) || "",
        url: image.url,
      });
    } catch {
      // A single unreachable image should not fail the whole export.
    }
  }

  if (manifest.length > 0) {
    folder?.file("alt-text.json", JSON.stringify(manifest, null, 2));
  }

  return zip.generateAsync({ type: "nodebuffer" });
}
