"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { JobView } from "./job-banner";

export type { JobView };

/**
 * Polls this client's jobs and refreshes the page when one finishes.
 *
 * Polling backs off to a slow tick when nothing is running, so an idle tab is
 * not hammering the database, and jumps to a fast tick the moment work starts.
 */
export function useJobs(clientId: string, types?: string[]) {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobView[]>([]);
  const activeRef = useRef(false);

  const poll = useCallback(async () => {
    const params = new URLSearchParams({ clientId });
    if (types?.length) params.set("types", types.join(","));

    try {
      const response = await fetch(`/api/jobs?${params}`, { cache: "no-store" });
      if (!response.ok) return;

      const data = (await response.json()) as { jobs: JobView[] };
      setJobs(data.jobs);

      const active = data.jobs.some(
        (job) => job.status === "queued" || job.status === "running",
      );

      // A job that has just left the active set has written its results, so the
      // server components showing them need re-rendering.
      if (activeRef.current && !active) router.refresh();
      activeRef.current = active;
    } catch {
      // Transient network failures are expected; the next tick retries.
    }
  }, [clientId, types?.join(","), router]);

  useEffect(() => {
    void poll();
    let timer: ReturnType<typeof setTimeout>;

    const schedule = (): void => {
      timer = setTimeout(async () => {
        await poll();
        schedule();
      }, activeRef.current ? 3_000 : 15_000);
    };
    schedule();

    return () => clearTimeout(timer);
  }, [poll]);

  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );

  return { jobs, active, refresh: poll };
}
