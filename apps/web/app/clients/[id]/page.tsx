import { Globe } from "lucide-react";
import { notFound } from "next/navigation";

import { listBrandAssets, getBrandVault } from "@/app/actions/brand-vault";
import { getClient } from "@/app/actions/clients";
import { BrandAssetsPanel } from "@/components/brand-assets-panel";
import { BrandVaultForm } from "@/components/brand-vault-form";
import { ClientJobBanner } from "@/components/client-job-banner";
import { CrawlSiteButton } from "@/components/crawl-site-button";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [client, vault, assets] = await Promise.all([
    getClient(id),
    getBrandVault(id),
    listBrandAssets(id),
  ]);
  if (!client) notFound();

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <PageHeader
        title="Knowledge Base"
        description="Everything here is injected into every prompt. The richer it is, the less the articles read like they could belong to anyone."
        actions={<CrawlSiteButton clientId={id} hasDomain={Boolean(client.domain)} />}
      />

      <ClientJobBanner clientId={id} types={["crawl_site"]} className="mb-5" />

      {vault?.siteCrawlSummary ? (
        <Card className="mb-5 border-primary/20 bg-primary/[0.03]">
          <CardContent className="pt-5">
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Globe className="size-4 text-primary" />
              From the website
              <span className="font-normal text-muted-foreground">
                · crawled {timeAgo(vault.siteCrawledAt)}
              </span>
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {vault.siteCrawlSummary}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-5">
        <BrandVaultForm clientId={id} vault={vault} />
        <BrandAssetsPanel clientId={id} assets={assets} />
      </div>
    </div>
  );
}
