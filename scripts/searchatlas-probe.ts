/**
 * Discovers and verifies the SearchAtlas endpoints.
 *
 * The adapter's paths are educated guesses: `docs.searchatlas.com` and
 * `api.searchatlas.com` are both unreachable from where this code was written,
 * so only the base URL and the `X-API-Key` header could be confirmed. Every
 * path is overridable through `SEARCHATLAS_PATH_*` precisely because they were
 * expected to need correcting.
 *
 * This script does the correcting from a machine that can reach the API. It
 * tries the OpenAPI manifest first — if the API publishes one, the real paths
 * come straight out of it — and falls back to trying candidates. Whatever it
 * finds, it prints the exact env lines to paste into `apps/worker/.env`.
 *
 *   pnpm searchatlas:probe
 *   pnpm searchatlas:probe --keyword "running shoes"
 */

import { config as loadEnv } from "dotenv";

// The key lives in the worker's env file, same as the worker reads it. Passing
// it as an argument would leave it in the shell history.
loadEnv({ path: "apps/worker/.env" });

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const BASE_URL = (
  process.env.SEARCHATLAS_BASE_URL ?? "https://api.searchatlas.com"
).replace(/\/+$/, "");

const TEST_KEYWORD = flag("keyword") ?? "running shoes";
const TEST_DOMAIN = flag("domain") ?? "nike.com";

const ok = (m: string): void => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m: string): void => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
const info = (m: string): void => console.log(`    ${m}`);

/**
 * Candidate paths per capability, best guess first.
 *
 * Brute force is the fallback, not the plan: if the API publishes an OpenAPI
 * manifest the real paths are read from it and this list goes unused.
 */
const CANDIDATES = {
  metrics: {
    envVar: "SEARCHATLAS_PATH_METRICS",
    label: "keyword metrics (volume, difficulty, CPC)",
    paths: [
      "/v2/keywords/overview",
      "/v2/keyword-researcher/overview",
      "/v2/keywords/metrics",
      "/v2/keywords/search-volume",
      "/api/v2/keywords/overview",
      "/v1/keywords/overview",
    ],
    body: () => ({ keywords: [TEST_KEYWORD], country: "US", language: "en" }),
  },
  related: {
    envVar: "SEARCHATLAS_PATH_RELATED",
    label: "related keywords",
    paths: [
      "/v2/keywords/related",
      "/v2/keyword-researcher/related",
      "/v2/keywords/ideas",
      "/v2/keywords/suggestions",
      "/api/v2/keywords/related",
    ],
    body: () => ({
      keyword: TEST_KEYWORD,
      keywords: [TEST_KEYWORD],
      country: "US",
      language: "en",
      limit: 10,
    }),
  },
  rankedKeywords: {
    envVar: "SEARCHATLAS_PATH_RANKED",
    label: "ranked keywords for a domain (this is what finds content gaps)",
    paths: [
      "/v2/domains/ranked-keywords",
      "/v2/site-explorer/ranked-keywords",
      "/v2/domains/keywords",
      "/v2/domain/ranked-keywords",
      "/api/v2/domains/ranked-keywords",
    ],
    body: () => ({
      domain: TEST_DOMAIN,
      target: TEST_DOMAIN,
      country: "US",
      language: "en",
      limit: 10,
    }),
  },
  serp: {
    envVar: "SEARCHATLAS_PATH_SERP",
    label: "SERP results",
    paths: [
      "/v2/serp",
      "/v2/serp/overview",
      "/v2/keywords/serp",
      "/api/v2/serp",
    ],
    body: () => ({
      keyword: TEST_KEYWORD,
      query: TEST_KEYWORD,
      country: "US",
      language: "en",
    }),
  },
} as const;

type Capability = keyof typeof CANDIDATES;

/** Paths an API might publish its own schema at. */
const MANIFEST_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v2/openapi.json",
  "/api/openapi.json",
  "/openapi.yaml",
];

type Attempt = {
  path: string;
  method: "GET" | "POST";
  status: number;
  body: string;
};

async function tryPath(
  apiKey: string,
  path: string,
  method: "GET" | "POST",
  payload?: unknown,
): Promise<Attempt | null> {
  try {
    const url =
      method === "GET" && payload
        ? `${BASE_URL}${path}?${new URLSearchParams(
            Object.entries(payload as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" || typeof v === "number")
              .map(([k, v]): [string, string] => [k, String(v)]),
          )}`
        : `${BASE_URL}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": apiKey,
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
      signal: AbortSignal.timeout(30_000),
    });

    return {
      path,
      method,
      status: response.status,
      body: (await response.text().catch(() => "")).slice(0, 600),
    };
  } catch {
    return null;
  }
}

function dump(label: string, text: string): void {
  console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}`);
  for (const line of text.split("\n").slice(0, 30)) console.log(`  ${line}`);
  console.log("");
}

/** Reads the real paths out of an OpenAPI manifest, if one is published. */
async function discoverFromManifest(apiKey: string): Promise<string[] | null> {
  for (const path of MANIFEST_PATHS) {
    const attempt = await tryPath(apiKey, path, "GET");
    if (!attempt || attempt.status !== 200 || !attempt.body) continue;

    try {
      const parsed = JSON.parse(attempt.body) as { paths?: Record<string, unknown> };
      if (parsed.paths) {
        ok(`the API publishes its schema at ${path}`);
        return Object.keys(parsed.paths);
      }
    } catch {
      // Truncated to 600 chars, so a large manifest will not parse. Refetch it
      // whole rather than giving up on the best source of truth available.
      const full = await fetch(`${BASE_URL}${path}`, {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(30_000),
      })
        .then((r) => r.json() as Promise<{ paths?: Record<string, unknown> }>)
        .catch(() => null);

      if (full?.paths) {
        ok(`the API publishes its schema at ${path}`);
        return Object.keys(full.paths);
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  console.log("\nSearchAtlas API probe\n");

  const apiKey = process.env.SEARCHATLAS_API_KEY?.trim();
  if (!apiKey) {
    bad("SEARCHATLAS_API_KEY is not set in apps/worker/.env");
    info("Add it there, or run `pnpm run configure`, then try again.");
    process.exit(1);
  }
  ok(`key loaded (${apiKey.slice(0, 6)}…${apiKey.slice(-4)})`);
  info(`base URL: ${BASE_URL}`);

  /* 1 — is anything there at all? ----------------------------------------- */

  console.log("\n1. Reachability and auth\n");

  const root = await tryPath(apiKey, "/", "GET");
  if (!root) {
    bad(`${BASE_URL} did not respond at all`);
    info("A proxy or firewall may be in the way. Nothing further to test.");
    process.exit(1);
  }
  ok(`${BASE_URL} responded (${root.status} at /)`);

  // A wrong key should be rejected identically everywhere, which distinguishes
  // "bad key" from "wrong path" for every later result.
  const withBadKey = await tryPath("definitely-not-a-real-key", "/", "GET");
  if (withBadKey && withBadKey.status === root.status && root.status < 400) {
    info("Note: / does not require auth, so it proves reachability only.");
  }

  /* 2 — does it publish a schema? ----------------------------------------- */

  console.log("\n2. Schema discovery\n");

  const published = await discoverFromManifest(apiKey);
  if (published) {
    const relevant = published.filter((p) =>
      /keyword|domain|serp|rank|volume|site/i.test(p),
    );
    dump(
      `relevant paths from the manifest (${relevant.length} of ${published.length})`,
      relevant.join("\n") || "(none matched keyword/domain/serp/rank)",
    );
    info("These are authoritative — prefer them over anything guessed below.");
  } else {
    info("No OpenAPI manifest found. Falling back to trying candidates.");
  }

  /* 3 — try the candidates ------------------------------------------------- */

  console.log("\n3. Endpoints\n");

  const resolved: Partial<Record<Capability, Attempt>> = {};

  for (const [capability, spec] of Object.entries(CANDIDATES) as [
    Capability,
    (typeof CANDIDATES)[Capability],
  ][]) {
    console.log(`\n  ${spec.label}`);

    const configured = process.env[spec.envVar];
    const paths = configured
      ? [configured, ...spec.paths.filter((p) => p !== configured)]
      : [...spec.paths];

    let found: Attempt | undefined;

    for (const path of paths) {
      for (const method of ["POST", "GET"] as const) {
        const attempt = await tryPath(apiKey, path, method, spec.body());
        if (!attempt) continue;

        if (attempt.status === 404) continue;

        if (attempt.status === 401 || attempt.status === 403) {
          bad(`${method} ${path} — ${attempt.status}, key rejected`);
          info(attempt.body.slice(0, 160));
          continue;
        }

        if (attempt.status === 405) continue; // wrong verb, keep trying

        if (attempt.status < 300) {
          ok(`${method} ${path} — ${attempt.status}`);
          found = attempt;
          break;
        }

        // 400/422 still proves the route exists; the payload shape is wrong.
        info(`${method} ${path} — ${attempt.status}, route exists but rejected the body`);
        info(attempt.body.slice(0, 200));
        found ??= attempt;
      }
      if (found && found.status < 300) break;
    }

    if (found) {
      resolved[capability] = found;
      if (found.status < 300) dump(`${capability} response`, found.body);
    } else {
      bad("nothing answered — none of the candidate paths exist");
    }
  }

  /* 4 — what to put in .env ------------------------------------------------ */

  console.log("\n4. Configuration\n");

  const working = Object.entries(resolved).filter(
    ([, attempt]) => attempt && attempt.status < 300,
  );

  if (working.length === 0) {
    bad("No endpoint returned data.");
    info("Send this output along — the paths can be corrected from it.");
    info("The manifest section above is the most useful part if it found any.");
    process.exit(1);
  }

  console.log("  Paste these into apps/worker/.env:\n");
  for (const [capability, attempt] of working) {
    const spec = CANDIDATES[capability as Capability];
    console.log(`  ${spec.envVar}="${attempt!.path}"`);
  }

  const missing = (Object.keys(CANDIDATES) as Capability[]).filter(
    (c) => !resolved[c] || resolved[c]!.status >= 300,
  );

  console.log("");
  if (missing.length === 0) {
    ok("All four endpoints answered. Keyword research is fully wired.");
  } else {
    console.log(`  Still unresolved: ${missing.join(", ")}`);
    for (const capability of missing) {
      if (capability === "rankedKeywords") {
        info(
          "Without ranked keywords there is no content gap analysis — that is " +
            "the one worth chasing.",
        );
      }
      if (capability === "metrics" || capability === "related") {
        info(
          `Without ${capability}, the keyword table loses volume figures but ` +
            "still clusters.",
        );
      }
    }
    info("Send this output and the adapter can be corrected.");
  }
  console.log("");
}

main().catch((error) => {
  console.error("\n  Probe failed:", error instanceof Error ? error.message : error);
  console.error(
    "\n  Send this output along — correcting the paths is what the probe is for.\n",
  );
  process.exit(1);
});
