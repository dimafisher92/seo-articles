"use client";

import { Check, Download, Save, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import type { Article, ArticleImage, BrandAsset } from "@seo/db";
import {
  countWords,
  markdownToHtml,
  META_DESCRIPTION_MAX,
  META_DESCRIPTION_MIN,
  readingTimeMinutes,
  runSeoChecks,
  TITLE_TAG_MAX,
} from "@seo/shared";

import { saveArticle, setArticleStatus } from "@/app/actions/articles";
import { ArticleImagesPanel } from "@/components/article-images-panel";
import { LengthMeter, SeoPanel } from "@/components/seo-panel";
import { Button } from "@/components/ui/button";
import { Field, Input, Label, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

type Tab = "write" | "preview" | "images" | "schema";

/**
 * The article workspace.
 *
 * Markdown is edited as text rather than through a rich-text surface: the body
 * is Markdown everywhere else in the system — export, schema, the worker's own
 * revisions — and a WYSIWYG layer would be a lossy round trip for a document
 * that mostly needs headings, links and tables.
 */
export function ArticleEditor({
  article,
  images,
  brandAssets,
}: {
  article: Article;
  images: ArticleImage[];
  brandAssets: BrandAsset[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("write");
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState({
    title: article.title,
    titleTag: article.titleTag ?? "",
    metaDescription: article.metaDescription ?? "",
    slug: article.slug ?? "",
    bodyMdx: article.bodyMdx ?? "",
  });

  // Recomputed as the writer types, from the same rubric the worker used.
  const liveScore = useMemo(
    () =>
      runSeoChecks({
        title: draft.title,
        titleTag: draft.titleTag,
        metaDescription: draft.metaDescription,
        slug: draft.slug,
        bodyMdx: draft.bodyMdx,
        mainKeyword: article.mainKeyword,
        secondaryKeywords: article.secondaryKeywords,
        faqCount: article.faq.length,
        internalLinkCount: article.internalLinks.length,
        externalSourceCount: article.externalSources.length,
        imageCount: images.filter((i) => i.status === "ready").length,
        imagesMissingAlt: images.filter((i) => !i.altText).length,
        targetWordCount: null,
      }),
    [draft, article, images],
  );

  const wordCount = useMemo(() => countWords(draft.bodyMdx), [draft.bodyMdx]);

  function update<K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function save(): void {
    setError(null);
    startTransition(async () => {
      const result = await saveArticle(article.id, draft);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-4">
        <nav className="flex gap-1 border-b border-border">
          {(
            [
              ["write", "Write"],
              ["preview", "Preview"],
              ["images", `Images (${images.length})`],
              ["schema", "Metadata & schema"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "write" ? (
          <div className="space-y-4">
            <Field label="H1">
              <Input
                value={draft.title}
                onChange={(e) => update("title", e.target.value)}
              />
            </Field>

            <div>
              <Label>Body (Markdown)</Label>
              <Textarea
                className="mt-1.5 min-h-[600px] font-mono text-[13px] leading-6"
                value={draft.bodyMdx}
                onChange={(e) => update("bodyMdx", e.target.value)}
                spellCheck
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {wordCount} words · {readingTimeMinutes(wordCount)} min read
              </p>
            </div>
          </div>
        ) : null}

        {tab === "preview" ? (
          <article
            className="prose-article rounded-xl border border-border bg-card p-8"
            dangerouslySetInnerHTML={{ __html: markdownToHtml(draft.bodyMdx) }}
          />
        ) : null}

        {tab === "images" ? (
          <ArticleImagesPanel images={images} brandAssets={brandAssets} />
        ) : null}

        {tab === "schema" ? (
          <div className="space-y-4">
            <Field
              label="Title tag"
              hint="What shows in the results page. Different from the H1 — it has to earn the click."
            >
              <Input
                value={draft.titleTag}
                onChange={(e) => update("titleTag", e.target.value)}
              />
              <LengthMeter
                value={draft.titleTag}
                max={TITLE_TAG_MAX}
                label="Title tag"
              />
            </Field>

            <Field label="Meta description">
              <Textarea
                rows={3}
                value={draft.metaDescription}
                onChange={(e) => update("metaDescription", e.target.value)}
              />
              <LengthMeter
                value={draft.metaDescription}
                min={META_DESCRIPTION_MIN}
                max={META_DESCRIPTION_MAX}
                label="Meta description"
              />
            </Field>

            <Field label="Slug">
              <Input
                value={draft.slug}
                onChange={(e) => update("slug", e.target.value)}
              />
            </Field>

            {article.faq.length > 0 ? (
              <div>
                <Label>FAQ ({article.faq.length})</Label>
                <ul className="mt-1.5 space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  {article.faq.map((entry, index) => (
                    <li key={index}>
                      <p className="font-medium">{entry.question}</p>
                      <p className="text-muted-foreground">{entry.answer}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {article.externalSources.length > 0 ? (
              <div>
                <Label>Cited sources ({article.externalSources.length})</Label>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {article.externalSources.map((source) => (
                    <li key={source.url}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-primary underline underline-offset-2"
                      >
                        {source.title}
                      </a>
                      {source.usedFor ? (
                        <span className="text-muted-foreground">
                          {" "}
                          — {source.usedFor}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <Label>JSON-LD</Label>
              <pre className="mt-1.5 max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs">
                {JSON.stringify(article.jsonLd, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </div>

      <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
        <div className="space-y-2">
          <Button className="w-full" onClick={save} disabled={pending}>
            {pending ? <Spinner /> : saved ? <Check /> : <Save />}
            {saved ? "Saved" : "Save"}
          </Button>

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending || article.status === "approved"}
              onClick={() =>
                startTransition(async () => {
                  await setArticleStatus(article.id, "approved");
                  router.refresh();
                })
              }
            >
              <ShieldCheck />
              {article.status === "approved" ? "Approved" : "Approve"}
            </Button>

            <Button variant="outline" size="sm" asChild>
              <a href={`/api/articles/${article.id}/export?format=zip`}>
                <Download />
                Export
              </a>
            </Button>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
            {(["md", "html", "docx"] as const).map((format) => (
              <a
                key={format}
                href={`/api/articles/${article.id}/export?format=${format}`}
                className="rounded-md border border-border py-1.5 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                .{format}
              </a>
            ))}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <SeoPanel
            score={liveScore}
            qaReport={article.qaReport}
            wordCount={wordCount}
            readingTime={readingTimeMinutes(wordCount)}
          />
        </div>
      </aside>
    </div>
  );
}
