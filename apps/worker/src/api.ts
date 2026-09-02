import {
  assetIngestResponseSchema,
  claimResponseSchema,
  type ClaimedJob,
  type JobProgressInput,
} from "@seo/shared";

import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Client for the queue endpoints on the Vercel app.
 *
 * The worker only ever makes outbound calls, which is what lets it sit on a
 * laptop behind NAT with no tunnel and no open ports.
 */

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.appUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.workerSecret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ApiError(
      `POST ${path} failed: ${response.status} ${response.statusText} ${text.slice(0, 300)}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function claimJob(): Promise<ClaimedJob | null> {
  const raw = await post<unknown>("/api/worker/claim", {
    workerId: config.workerId,
  });
  return claimResponseSchema.parse(raw).job;
}

/**
 * Reports progress, and returns whether the job has been cancelled.
 *
 * The worker pulls and has no inbox, so this response is the only channel that
 * reaches it while a job runs. A cancellation rides back on the heartbeat the
 * worker was already sending.
 *
 * A dropped heartbeat reports "not cancelled": a network blip must not stop an
 * article, and the reaper only requeues after several minutes of silence.
 */
export async function reportProgress(
  jobId: string,
  progress: JobProgressInput,
): Promise<boolean> {
  try {
    const response = await post<{ canceled?: boolean }>(
      `/api/worker/jobs/${jobId}/progress`,
      progress,
    );
    return response.canceled === true;
  } catch (error) {
    log.warn(`heartbeat failed for job ${jobId}`, error);
    return false;
  }
}

export async function reportComplete(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await post(`/api/worker/jobs/${jobId}/complete`, { result });
}

export async function reportFailure(
  jobId: string,
  error: string,
  retryable: boolean,
): Promise<void> {
  await post(`/api/worker/jobs/${jobId}/fail`, { error, retryable });
}

/**
 * Asks the app to copy a provider image URL into Blob storage. Done app-side
 * because Magnific links expire and Vercel caps request bodies well below the
 * size of a 2K render.
 */
export async function ingestImage(input: {
  sourceUrl: string;
  clientId: string;
  prefix: string;
  filename: string;
}): Promise<{ blobUrl: string; pathname: string }> {
  const raw = await post<unknown>("/api/worker/assets/ingest", input);
  return assetIngestResponseSchema.parse(raw);
}
