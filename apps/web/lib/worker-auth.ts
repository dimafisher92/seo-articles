import { timingSafeEqual } from "node:crypto";

import { env } from "./env";

/**
 * Bearer check for the worker endpoints.
 *
 * Compared in constant time: these routes are public on the internet and a
 * naive `===` leaks the secret one byte at a time to anyone willing to measure.
 */
export function isWorkerAuthorized(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(env.workerSecret);

  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
