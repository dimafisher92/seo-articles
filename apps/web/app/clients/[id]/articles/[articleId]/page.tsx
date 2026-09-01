import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getArticle, listArticleImages } from "@/app/actions/articles";
import { listBrandAssets } from "@/app/actions/brand-vault";
import { ArticleEditor } from "@/components/article-editor";
import { ClientJobBanner } from "@/components/client-job-banner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}) {
  const { id, articleId } = await params;

  const article = await getArticle(articleId);
  if (!article || article.clientId !== id) notFound();

  const [images, brandAssets] = await Promise.all([
    listArticleImages(articleId),
    listBrandAssets(id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-5">
        <Link
          href={`/clients/${id}/articles`}
          className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          All articles
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {article.title}
          </h1>
          <Badge
            variant={
              article.status === "approved"
                ? "success"
                : article.status === "needs_attention"
                  ? "destructive"
                  : "outline"
            }
          >
            {article.status === "needs_attention"
              ? "needs attention"
              : article.status}
          </Badge>
          {article.mainKeyword ? (
            <span className="text-sm text-muted-foreground">
              {article.mainKeyword}
            </span>
          ) : null}
        </div>
      </div>

      {article.status === "needs_attention" ? (
        <Card className="mb-5 border-destructive/40 bg-destructive/5">
          <CardContent className="space-y-2 pt-5">
            <p className="text-sm font-medium text-destructive">
              The review still objects to this article
            </p>
            <p className="text-sm text-muted-foreground">
              Everything is saved, but these were not resolved after three
              revision passes. Read them before publishing — invented figures
              and claims about the client&apos;s own terms are the usual causes.
            </p>
            <ul className="space-y-1.5 pt-1">
              {(article.qaReport?.issues ?? [])
                .filter((issue) => issue.severity === "high")
                .map((issue, index) => (
                  <li key={index} className="text-sm">
                    {issue.note}
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <ClientJobBanner
        clientId={id}
        types={["write_article", "regenerate_image"]}
        className="mb-5"
      />

      {article.bodyMdx ? (
        <ArticleEditor
          article={article}
          images={images}
          brandAssets={brandAssets}
        />
      ) : (
        <p className="rounded-xl border border-dashed border-border px-6 py-16 text-center text-sm text-muted-foreground">
          This article has not been written yet. If a generation job is running,
          the draft appears here when it finishes.
        </p>
      )}
    </div>
  );
}
