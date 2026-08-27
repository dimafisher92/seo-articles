import { Mountain } from "lucide-react";
import { notFound } from "next/navigation";

import { getBrandVault } from "@/app/actions/brand-vault";
import { getClient } from "@/app/actions/clients";
import { latestKeywordRun, listKeywords } from "@/app/actions/keywords";
import { BuildPlanButton } from "@/components/build-plan-button";
import { ClientJobBanner } from "@/components/client-job-banner";
import { KeywordResearchLauncher } from "@/components/keyword-research-launcher";
import { KeywordTable } from "@/components/keyword-table";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { gapHint } from "@/lib/gap-hint";
import { formatNumber, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function KeywordsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [client, vault, run] = await Promise.all([
    getClient(id),
    getBrandVault(id),
    latestKeywordRun(id),
  ]);
  if (!client) notFound();

  const keywords = run ? await listKeywords(run.id) : [];
  const selectedCount = keywords.filter((k) => k.selected).length;
  const hasVolumeData = keywords.some((k) => k.volume !== null);

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-10">
      <PageHeader
        title="Keyword Research"
        description="Research and content gap run before any planning. Tick the keywords worth writing about, then build the plan."
        actions={
          <KeywordResearchLauncher
            clientId={id}
            vaultCompetitors={vault?.competitors ?? []}
            hasExistingRun={Boolean(run)}
          />
        }
      />

      <ClientJobBanner
        clientId={id}
        types={["keyword_research"]}
        className="mb-5"
      />

      {run?.summary ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <Stat label="Keywords" value={formatNumber(run.summary.totalKeywords)} />
          <Stat
            label="Content gaps"
            value={formatNumber(run.summary.gapKeywords)}
            hint={gapHint(run.summary)}
          />
          <Stat
            label="Clusters"
            value={formatNumber(run.summary.clusters?.length)}
          />
          <Stat label="Last run" value={timeAgo(run.finishedAt ?? run.createdAt)} />
        </div>
      ) : null}

      {run?.summary?.notes ? (
        <Card className="mb-5 border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-5 text-sm text-amber-800 dark:text-amber-300">
            {run.summary.notes}
          </CardContent>
        </Card>
      ) : null}

      {run?.status === "failed" ? (
        <Card className="mb-5 border-destructive/30 bg-destructive/5">
          <CardContent className="pt-5 text-sm">
            <p className="font-medium text-destructive">Research failed</p>
            <p className="mt-1 text-muted-foreground">{run.error}</p>
          </CardContent>
        </Card>
      ) : null}

      {keywords.length === 0 ? (
        <EmptyState
          icon={<Mountain className="size-8" />}
          title={run ? "No keywords yet" : "No research run yet"}
          description={
            run?.status === "running" || run?.status === "pending"
              ? "The run is in progress. Results appear here as soon as it finishes."
              : "Fill in the Knowledge Base first — seeds and competitors come from there — then start a research run."
          }
          action={
            <KeywordResearchLauncher
              clientId={id}
              vaultCompetitors={vault?.competitors ?? []}
              hasExistingRun={Boolean(run)}
            />
          }
        />
      ) : (
        <>
          <KeywordTable
            clientId={id}
            keywords={keywords}
            hasVolumeData={hasVolumeData}
          />

          <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/85 py-3 backdrop-blur">
            <p className="text-sm text-muted-foreground">
              {selectedCount === 0
                ? "Tick the keywords worth writing about."
                : `${selectedCount} keyword${selectedCount === 1 ? "" : "s"} selected.`}
            </p>
            {run ? (
              <BuildPlanButton
                clientId={id}
                runId={run.id}
                selectedCount={selectedCount}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
