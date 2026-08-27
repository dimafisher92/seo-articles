import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getArticle, listArticleImages } from "@/app/actions/articles";
import { listBrandAssets } from "@/app/actions/brand-vault";
import { ArticleEditor } from "@/components/article-editor";
import { ClientJobBanner } from "@/components/client-job-banner";
import { Badge } from "@/components/ui/badge";

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
            variant={article.status === "approved" ? "success" : "outline"}
          >
            {article.status}
          </Badge>
          {article.mainKeyword ? (
            <span className="text-sm text-muted-foreground">
              {article.mainKeyword}
            </span>
          ) : null}
        </div>
      </div>

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
