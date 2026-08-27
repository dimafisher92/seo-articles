import { getDb } from "@seo/db";

/**
 * Route handlers and server components call `db()` rather than a module-level
 * instance, so the connection is created on first use inside a request and not
 * during the Vercel build (where DATABASE_URL is absent).
 */
export const db = getDb;
