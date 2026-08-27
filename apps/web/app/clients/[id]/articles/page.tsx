import { FileText } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { listArticles } from "@/app/actions/articles";
import { getClient } from "@/app/actions/clients";
import { ClientJobBanner } from "@/components/client-job-banner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { cn, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ArticlesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [client, articles] = await Promise.all([
    getClient(id),
    listArticles(id),
  ]);
  if (!client) notFound();

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <PageHeader
        title="Articles"
        description="Drafts generated from the content plan. Edit, approve and export."
      />

      <ClientJobBanner
        clientId={id}
        types={["write_article", "regenerate_image"]}
        className="mb-5"
      />

      {articles.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-8" />}
          title="No articles yet"
          description="Articles appear here once you commission them from the content plan."
          action={
            <Button variant="outline" asChild>
              <Link href={`/clients/${id}/plan`}>Go to the content plan</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {articles.map((article) => {
            const score = article.seoScore?.total ?? 0;
            return (
              <li key={article.id}>
                <Link
                  href={`/clients/${id}/articles/${article.id}`}
                  className="flex flex-wrap items-center gap-3 bg-card px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{article.title}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {article.mainKeyword ?? "no main keyword"}
                      {article.wordCount ? ` · ${article.wordCount} words` : ""}
                      {` · edited ${timeAgo(article.updatedAt)}`}
                    </p>
                  </div>

                  {article.seoScore ? (
                    <span
                      className={cn(
                        "shrink-0 text-sm font-semibold tabular-nums",
                        score >= 80
                          ? "text-success"
                          : score >= 60
                            ? "text-primary"
                            : "text-destructive",
                      )}
                      title="On-page score"
                    >
                      {score}
                    </span>
                  ) : null}

                  <Badge
                    variant={
                      article.status === "approved"
                        ? "success"
                        : article.status === "exported"
                          ? "secondary"
                          : "outline"
                    }
                    className="shrink-0"
                  >
                    {article.status}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
