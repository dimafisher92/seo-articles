import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

import { sanitizeConnectionString } from "./src/url.js";

/**
 * `pnpm run configure` writes `DATABASE_URL_UNPOOLED` into the worker's env
 * file — the direct connection is wanted by migrations and by the worker, never
 * by the app on Vercel — and `pnpm db:push` is the very next thing anyone runs.
 * Without this it would not see it: drizzle-kit loads no env file of its own,
 * so the command fails with `url: ''` while the value sits in a file the
 * project itself created two commands earlier.
 *
 * The path is resolved from this file rather than the working directory,
 * because `db:push` runs from the repo root and the config lives here.
 *
 * dotenv does not overwrite variables that are already set, so an explicit
 * `DATABASE_URL_UNPOOLED=… pnpm db:push` still wins over the file.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, "..", "..", "apps", "worker", ".env") });

/**
 * Migrations must run over a **direct** connection, not the pooled one.
 *
 * Neon's pooled endpoint is PgBouncer in transaction mode, which has no session
 * state. Schema tools rely on it, and when it is missing they fail in ways that
 * never mention pooling: `prepared statement "s0" already exists`, a
 * `SET search_path` that evaporates after its own transaction so the next
 * statement cannot see the table, or a write landing on a backend that
 * inherited a read-only transaction.
 *
 * `neon env pull` writes both strings, so `DATABASE_URL_UNPOOLED` is usually
 * already there. The runtime keeps using the pooled `DATABASE_URL` — serverless
 * functions open a connection per request and would exhaust the direct
 * endpoint's slots.
 */
const raw = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

/**
 * Same sanitising as the runtime driver, and it matters more here: drizzle-kit
 * also runs on postgres-js, and given Neon's `channel_binding=require` it does
 * not report the rejected startup parameter — it simply hangs on "Pulling
 * schema from database" forever.
 */
const url = raw ? sanitizeConnectionString(raw) : raw;

if (url?.includes("-pooler")) {
  console.warn(
    "\n⚠  Running migrations over a pooled connection.\n" +
      "   Set DATABASE_URL_UNPOOLED to the string without `-pooler` in the\n" +
      "   hostname — `neon env pull` writes it for you. Migrations can fail\n" +
      "   here in ways that do not mention pooling.\n",
  );
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: url! },
  strict: true,
  verbose: true,
});
