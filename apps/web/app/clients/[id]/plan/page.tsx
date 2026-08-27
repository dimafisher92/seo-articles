import { BookOpen } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getClient } from "@/app/actions/clients";
import {
  latestContentPlan,
  latestKeywordRun,
  listKeywords,
  listPlanItems,
} from "@/app/actions/keywords";
import { BuildPlanButton } from "@/components/build-plan-button";
import { ClientJobBanner } from "@/components/client-job-banner";
import { PageHeader } from "@/components/page-header";
import { PlanTable } from "@/components/plan-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [client, plan, run] = await Promise.all([
    getClient(id),
    latestContentPlan(id),
    latestKeywordRun(id),
  ]);
  if (!client) notFound();

  const [items, keywords] = await Promise.all([
    plan ? listPlanItems(plan.id) : Promise.resolve([]),
    run ? listKeywords(run.id) : Promise.resolve([]),
  ]);
  const selectedCount = keywords.filter((k) => k.selected).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <PageHeader
        title="Content Plan"
        description="Titles and briefs only. Commission each article individually when you are happy with its angle."
        actions={
          run ? (
            <BuildPlanButton
              clientId={id}
              runId={run.id}
              selectedCount={selectedCount}
            />
          ) : null
        }
      />

      <ClientJobBanner
        clientId={id}
        types={["content_plan", "write_article"]}
        className="mb-5"
      />

      {plan?.status === "failed" ? (
        <Card className="mb-5 border-destructive/30 bg-destructive/5">
          <CardContent className="pt-5 text-sm">
            <p className="font-medium text-destructive">Planning failed</p>
            <p className="mt-1 text-muted-foreground">{plan.error}</p>
          </CardContent>
        </Card>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-8" />}
          title={plan ? "No titles yet" : "No content plan yet"}
          description={
            !run
              ? "Run keyword research first — the plan is built from the keywords you select there."
              : selectedCount === 0
                ? "Go back to the keyword table and tick the keywords worth writing about."
                : plan?.status === "running" || plan?.status === "pending"
                  ? "Planning is in progress. Titles appear here as soon as it finishes."
                  : `${selectedCount} keywords are selected. Build the plan to turn them into article titles.`
          }
          action={
            !run || selectedCount === 0 ? (
              <Button variant="outline" asChild>
                <Link href={`/clients/${id}/keywords`}>
                  Go to keyword research
                </Link>
              </Button>
            ) : (
              <BuildPlanButton
                clientId={id}
                runId={run.id}
                selectedCount={selectedCount}
              />
            )
          }
        />
      ) : (
        <PlanTable clientId={id} items={items} />
      )}
    </div>
  );
}
