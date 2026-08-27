import { defineConfig } from "drizzle-kit";

import { sanitizeConnectionString } from "./src/url.js";

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
