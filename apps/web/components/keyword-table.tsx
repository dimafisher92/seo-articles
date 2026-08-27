"use client";

import {
  ArrowUpDown,
  ExternalLink,
  Search,
  Target,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import type { Keyword } from "@seo/db";

import { setKeywordSelection } from "@/app/actions/keywords";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { cn, formatNumber } from "@/lib/utils";

type SortKey = "priority" | "volume" | "difficulty" | "keyword";

const INTENT_VARIANT = {
  transactional: "success",
  commercial: "default",
  informational: "secondary",
  navigational: "outline",
} as const;

/**
 * The keyword table.
 *
 * Selection is what feeds the content plan, so it is the primary interaction:
 * bulk-select the visible rows, filter down to a cluster or to gaps only, then
 * tick what is worth writing.
 */
export function KeywordTable({
  clientId,
  keywords,
  hasVolumeData,
}: {
  clientId: string;
  keywords: Keyword[];
  hasVolumeData: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [query, setQuery] = useState("");
  const [cluster, setCluster] = useState<string>("all");
  const [gapsOnly, setGapsOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(keywords.filter((k) => k.selected).map((k) => k.id)),
  );

  const clusters = useMemo(() => {
    const names = new Set<string>();
    for (const keyword of keywords) {
      if (keyword.cluster) names.add(keyword.cluster);
    }
    return [...names].sort();
  }, [keywords]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = keywords.filter((k) => {
      if (gapsOnly && !k.isGap) return false;
      if (cluster !== "all" && k.cluster !== cluster) return false;
      if (needle && !k.keyword.toLowerCase().includes(needle)) return false;
      return true;
    });

    return rows.sort((a, b) => {
      switch (sortKey) {
        case "volume":
          return (b.volume ?? -1) - (a.volume ?? -1);
        case "difficulty":
          return (a.difficulty ?? 101) - (b.difficulty ?? 101);
        case "keyword":
          return a.keyword.localeCompare(b.keyword);
        default:
          return (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
      }
    });
  }, [keywords, query, cluster, gapsOnly, sortKey]);

  function persist(ids: string[], nextSelected: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (nextSelected) next.add(id);
        else next.delete(id);
      }
      return next;
    });

    startTransition(async () => {
      await setKeywordSelection(clientId, ids, nextSelected);
      router.refresh();
    });
  }

  const visibleIds = visible.map((k) => k.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Filter keywords…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <select
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          className="h-9 rounded-md border border-input bg-card px-2 text-sm"
        >
          <option value="all">All clusters ({clusters.length})</option>
          {clusters.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <Button
          variant={gapsOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setGapsOnly((v) => !v)}
          title="Keywords competitors rank for and this client does not"
        >
          <Target />
          Gaps only
        </Button>

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="h-9 rounded-md border border-input bg-card px-2 text-sm"
        >
          <option value="priority">Sort: priority</option>
          <option value="volume">Sort: volume</option>
          <option value="difficulty">Sort: easiest first</option>
          <option value="keyword">Sort: A–Z</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={(e) => persist(visibleIds, e.target.checked)}
            className="size-4 accent-[hsl(var(--primary))]"
          />
          Select all {visible.length} shown
        </label>

        <span className="text-muted-foreground">
          {selected.size} selected overall
        </span>

        {selected.size > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => persist([...selected], false)}
          >
            Clear selection
          </Button>
        ) : null}

        {pending ? <Spinner className="text-muted-foreground" /> : null}
      </div>

      {!hasVolumeData ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          No keyword data provider is configured on the worker, so volume and
          difficulty are blank. Clusters and content gaps still work. Set
          <code className="mx-1 rounded bg-muted px-1">SEARCHATLAS_API_KEY</code>
          to fill these columns.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/60 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="w-10 px-3 py-2.5" />
              <th className="px-3 py-2.5 font-medium">Keyword</th>
              <th className="w-24 px-3 py-2.5 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  Volume <ArrowUpDown className="size-3" />
                </span>
              </th>
              <th className="w-20 px-3 py-2.5 text-right font-medium">KD</th>
              <th className="w-32 px-3 py-2.5 font-medium">Intent</th>
              <th className="px-3 py-2.5 font-medium">Cluster</th>
              <th className="w-28 px-3 py-2.5 text-right font-medium">
                Priority
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((keyword) => {
              const isSelected = selected.has(keyword.id);
              return (
                <tr
                  key={keyword.id}
                  className={cn(
                    "border-b border-border/60 transition-colors last:border-0",
                    isSelected ? "bg-primary/[0.04]" : "hover:bg-muted/40",
                  )}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => persist([keyword.id], e.target.checked)}
                      className="size-4 accent-[hsl(var(--primary))]"
                      aria-label={`Select ${keyword.keyword}`}
                    />
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{keyword.keyword}</span>
                      {keyword.isGap ? (
                        <GapBadge
                          competitorCount={keyword.competitorUrls.length}
                          topUrl={keyword.competitorUrls[0]?.url}
                        />
                      ) : null}
                    </div>
                    {keyword.clientRank ? (
                      <span className="text-xs text-muted-foreground">
                        currently #{keyword.clientRank}
                      </span>
                    ) : null}
                  </td>

                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(keyword.volume)}
                  </td>

                  <td className="px-3 py-2 text-right tabular-nums">
                    {keyword.difficulty === null ? (
                      "—"
                    ) : (
                      <span
                        className={cn(
                          keyword.difficulty <= 30 && "text-success",
                          keyword.difficulty > 60 && "text-destructive",
                        )}
                      >
                        {keyword.difficulty}
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {keyword.intent ? (
                      <Badge variant={INTENT_VARIANT[keyword.intent]}>
                        {keyword.intent}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>

                  <td className="max-w-[220px] truncate px-3 py-2 text-muted-foreground">
                    {keyword.cluster ?? "—"}
                  </td>

                  <td className="px-3 py-2 text-right">
                    <PriorityBar score={keyword.priorityScore} />
                  </td>
                </tr>
              );
            })}

            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-10 text-center text-muted-foreground"
                >
                  No keywords match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GapBadge({
  competitorCount,
  topUrl,
}: {
  competitorCount: number;
  topUrl?: string;
}) {
  const badge = (
    <Badge variant="warning" className="shrink-0">
      <Target className="size-3" />
      gap · {competitorCount}
    </Badge>
  );

  if (!topUrl) return badge;

  return (
    <a
      href={topUrl}
      target="_blank"
      rel="noreferrer noopener"
      title={`${competitorCount} competitor(s) rank here. Top: ${topUrl}`}
      className="inline-flex items-center gap-0.5 hover:opacity-80"
    >
      {badge}
      <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

function PriorityBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            score >= 66 ? "bg-success" : score >= 33 ? "bg-primary" : "bg-muted-foreground/40",
          )}
          style={{ width: `${Math.max(3, score)}%` }}
        />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {Math.round(score)}
      </span>
    </div>
  );
}
