import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { jobs } from "@seo/db";

import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Job status for the client-side progress poller.
 *
 * Long jobs are watched by polling rather than a streamed connection: Vercel
 * functions are not a good home for a connection held open for fifteen
 * minutes, and a poll survives the tab sleeping or the network flapping.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await currentUser())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");

  // Postgres raises on a malformed uuid, which would surface as a 500 for what
  // is really a bad request.
  if (!clientId || !z.string().uuid().safeParse(clientId).success) {
    return Response.json(
      { error: "clientId must be a uuid" },
      { status: 400 },
    );
  }

  const types = url.searchParams.get("types")?.split(",").filter(Boolean);

  const rows = await db()
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      progress: jobs.progress,
      error: jobs.error,
      result: jobs.result,
      attempts: jobs.attempts,
      createdAt: jobs.createdAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(
      types?.length
        ? and(
            eq(jobs.clientId, clientId),
            inArray(
              jobs.type,
              types as (typeof jobs.type.enumValues)[number][],
            ),
          )
        : eq(jobs.clientId, clientId),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(20);

  return Response.json({ jobs: rows });
}
