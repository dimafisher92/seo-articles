"use client";

import { JobStatusList } from "@/components/job-status";
import { useJobs } from "@/lib/use-jobs";

/**
 * Live job banner for a page. Polls in the background and refreshes the server
 * components underneath when a job finishes, so results appear without the
 * user having to reload.
 */
export function ClientJobBanner({
  clientId,
  types,
  className,
}: {
  clientId: string;
  types?: string[];
  className?: string;
}) {
  const { jobs } = useJobs(clientId, types);
  return <JobStatusList jobs={jobs} className={className} />;
}
