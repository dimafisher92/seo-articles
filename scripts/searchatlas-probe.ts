/**
 * Discovers the SearchAtlas endpoints from a machine that can reach them.
 *
 * The adapter ships with guessed endpoints, and a live run has already proved
 * them wrong: none of the candidate paths existed. Two facts came out of that
 * run and the published material around it, and they shape what this script
 * does:
 *
 *   1. Each SearchAtlas service has its own host — the one confirmed example is
 *      `keyword.searchatlas.com/api/v2/rank-tracker/…`, not a path under a
 *      shared `api.searchatlas.com`. Sweeping paths on one host was never going
 *      to find anything.
 *   2. `docs.searchatlas.com` is blocked from where this code was written, and
 *      open from where it runs. So the script reads the documentation itself
 *      rather than guessing on the reader's behalf.
 *
 * Order of preference, most authoritative first:
 *
 *   A. a machine-readable spec (OpenAPI, or the `llms.txt` modern doc
 *      platforms publish) — endpoints come out exactly, no guessing at all
 *   B. the docs sitemap and page HTML, scraped for `/api/v2/…` strings
 *   C. a sweep of plausible service hosts, as a last resort
 *
 * Whatever it finds, it prints lines ready to paste into `apps/worker/.env`.
 *
 *   pnpm searchatlas:probe
 *   pnpm searchatlas:probe --keyword "running shoes" --domain nike.com
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

const TEST_KEYWORD = flag("keyword") ?? "running shoes";
const TEST_DOMAIN = flag("domain") ?? "nike.com";

const DOCS_ORIGIN = process.env.SEARCHATLAS_DOCS_URL ?? "https://docs.searchatlas.com";

const ok = (m: string): void => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m: string): void => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
const info = (m: string): void => console.log(`    ${m}`);

/* ------------------------------------------------------------- capabilities */

type Capability = "metrics" | "related" | "rankedKeywords" | "serp";

const CAPABILITIES: Record<
  Capability,
  {
    envVar: string;
    label: string;
    /** Words that mark a documented endpoint as this capability. */
    match: RegExp;
    /** Tried only when discovery turns up nothing for this capability. */
    fallback: string[];
    body: () => Record<string, unknown>;
  }
> = {
  metrics: {
    envVar: "SEARCHATLAS_PATH_METRICS",
    label: "keyword metrics (volume, difficulty, CPC)",
    match: /(keyword).*(overview|metric|volume|difficult|magic|explore)/i,
    fallback: [
      "/api/v2/keywords/overview",
      "/api/v2/keyword-magic/overview",
      "/api/v2/keyword-researcher/overview",
      "/api/v2/keywords/metrics",
    ],
    body: () => ({
      keywords: [TEST_KEYWORD],
      keyword: TEST_KEYWORD,
      country: "US",
      country_code: "US",
      language: "en",
    }),
  },
  related: {
    envVar: "SEARCHATLAS_PATH_RELATED",
    label: "related keywords / ideas",
    match: /(keyword).*(related|idea|suggest|similar|expand)/i,
    fallback: [
      "/api/v2/keywords/related",
      "/api/v2/keyword-magic/ideas",
      "/api/v2/keywords/suggestions",
    ],
    body: () => ({
      keyword: TEST_KEYWORD,
      keywords: [TEST_KEYWORD],
      country: "US",
      country_code: "US",
      language: "en",
      limit: 10,
    }),
  },
  rankedKeywords: {
    envVar: "SEARCHATLAS_PATH_RANKED",
    label: "ranked keywords for a domain — this is what finds content gaps",
    match: /(site.?explorer|domain|competitor).*(keyword|rank|organic)/i,
    fallback: [
      "/api/v2/site-explorer/organic-keywords",
      "/api/v2/site-explorer/ranked-keywords",
      "/api/v2/site-explorer/keywords",
      "/api/v2/domains/ranked-keywords",
    ],
    body: () => ({
      domain: TEST_DOMAIN,
      target: TEST_DOMAIN,
      url: TEST_DOMAIN,
      country: "US",
      country_code: "US",
      language: "en",
      limit: 10,
    }),
  },
  serp: {
    envVar: "SEARCHATLAS_PATH_SERP",
    label: "SERP results",
    match: /serp/i,
    fallback: ["/api/v2/serp", "/api/v2/serp/overview", "/api/v2/keywords/serp"],
    body: () => ({
      keyword: TEST_KEYWORD,
      query: TEST_KEYWORD,
      country: "US",
      country_code: "US",
      language: "en",
    }),
  },
};

/** Hosts to sweep in stage C. Ordered by how likely each is to be the one. */
const SERVICE_HOSTS = [
  process.env.SEARCHATLAS_BASE_URL,
  "https://keyword.searchatlas.com",
  "https://site-explorer.searchatlas.com",
  "https://api.searchatlas.com",
  "https://app.searchatlas.com",
  "https://otto.searchatlas.com",
].filter((h, i, all): h is string => Boolean(h) && all.indexOf(h) === i);

/* ------------------------------------------------------------------ helpers */

type Attempt = {
  url: string;
  method: "GET" | "POST";
  status: number;
  body: string;
};

async function fetchText(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string } | null> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: response.status,
      text: await response.text().catch(() => ""),
    };
  } catch {
    return null;
  }
}

async function call(
  apiKey: string,
  url: string,
  method: "GET" | "POST",
  payload: Record<string, unknown>,
): Promise<Attempt | null> {
  let target = url;
  const init: RequestInit = {
    method,
    headers: { "X-API-Key": apiKey, accept: "application/json" },
  };

  if (method === "GET") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    target += (target.includes("?") ? "&" : "?") + params.toString();
  } else {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(payload);
  }

  const result = await fetchText(target, init);
  if (!result) return null;
  return { url, method, status: result.status, body: result.text.slice(0, 800) };
}

function dump(label: string, text: string, lines = 30): void {
  console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 56 - label.length))}`);
  for (const line of text.split("\n").slice(0, lines)) console.log(`  ${line}`);
  console.log("");
}

/** Every absolute or `/api/…` URL mentioned in a blob of text. */
function harvestEndpoints(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(
    /https?:\/\/[a-z0-9.-]*searchatlas\.com\/[a-z0-9/_{}.-]*/gi,
  )) {
    found.add(match[0].replace(/[.,)"'`]+$/, ""));
  }
  for (const match of text.matchAll(/["'`\s(](\/api\/v\d[a-z0-9/_{}.-]*)/gi)) {
    if (match[1]) found.add(match[1].replace(/[.,)"'`]+$/, ""));
  }

  return [...found];
}

/* ----------------------------------------------- stage A: machine-readable */

const SPEC_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/api-reference/openapi.json",
  "/swagger.json",
  "/spec.json",
  "/llms.txt",
  "/llms-full.txt",
];

async function readSpec(): Promise<string[]> {
  const found: string[] = [];

  for (const path of SPEC_PATHS) {
    const result = await fetchText(`${DOCS_ORIGIN}${path}`);
    if (!result || result.status !== 200 || result.text.length < 40) continue;

    // An HTML shell means the doc site served its app, not a spec.
    if (/^\s*<(!doctype|html)/i.test(result.text)) continue;

    ok(`${path} — ${(result.text.length / 1024).toFixed(0)} KB`);

    try {
      const parsed = JSON.parse(result.text) as { paths?: Record<string, unknown> };
      if (parsed.paths) {
        info("OpenAPI spec — these paths are authoritative, not guesses");
        found.push(...Object.keys(parsed.paths));
        continue;
      }
    } catch {
      // llms.txt and YAML are not JSON; scrape them the same as any prose.
    }
    found.push(...harvestEndpoints(result.text));
  }

  return [...new Set(found)];
}

/* ------------------------------------------------------ stage B: the docs */

async function readDocs(): Promise<string[]> {
  const found: string[] = [];

  const sitemap = await fetchText(`${DOCS_ORIGIN}/sitemap.xml`);
  const pages = sitemap?.text
    ? [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1]!)
        .filter((url) => /keyword|serp|explor|domain|rank|volume|search/i.test(url))
        .slice(0, 25)
    : [];

  if (pages.length > 0) {
    ok(`sitemap lists ${pages.length} pages that look relevant`);
    for (const page of pages) {
      const html = await fetchText(page);
      if (html?.text) found.push(...harvestEndpoints(html.text));
    }
  } else {
    const home = await fetchText(DOCS_ORIGIN);
    if (home?.text) {
      info("no usable sitemap — scraping the documentation home page");
      found.push(...harvestEndpoints(home.text));
    }
  }

  return [...new Set(found)];
}

/* ------------------------------------------------ stage C: verify for real */

async function verify(
  apiKey: string,
  capability: Capability,
  candidates: string[],
): Promise<Attempt | null> {
  const spec = CAPABILITIES[capability];
  let best: Attempt | null = null;

  for (const candidate of candidates) {
    // A documented path with no host is tried against every service host;
    // a full URL is tried as given.
    const urls = /^https?:\/\//i.test(candidate)
      ? [candidate]
      : SERVICE_HOSTS.map((host) => `${host}${candidate}`);

    for (const url of urls) {
      if (/\{|\}|:[a-z_]+/i.test(url)) continue; // needs an id we do not have

      for (const method of ["GET", "POST"] as const) {
        const attempt = await call(apiKey, url, method, spec.body());
        if (!attempt) continue;
        if (attempt.status === 404 || attempt.status === 405) continue;

        if (attempt.status === 401 || attempt.status === 403) {
          // Ambiguous: the key, or a proxy sitting in front of the host. The
          // body almost always says which, so it is always printed.
          bad(
            `${method} ${url} — ${attempt.status}, rejected (the key, or ` +
              "something between you and the host)",
          );
          info(attempt.body.slice(0, 160));
          continue;
        }

        if (attempt.status < 300) {
          ok(`${method} ${url} — ${attempt.status}`);
          return attempt;
        }

        // 400/422 still proves the route exists; only the payload is wrong.
        info(`${method} ${url} — ${attempt.status}, route exists, body rejected`);
        info(attempt.body.slice(0, 200));
        best ??= attempt;
      }
    }
  }

  return best;
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log("\nSearchAtlas endpoint discovery\n");

  const apiKey = process.env.SEARCHATLAS_API_KEY?.trim();
  if (!apiKey) {
    bad("SEARCHATLAS_API_KEY is not set in apps/worker/.env");
    info("Add it there, or run `pnpm run configure`, then try again.");
    process.exit(1);
  }
  ok(`key loaded (${apiKey.slice(0, 6)}…${apiKey.slice(-4)})`);
  info(`docs: ${DOCS_ORIGIN}`);

  /* A ---------------------------------------------------------------- */

  console.log("\n1. Machine-readable spec\n");
  const fromSpec = await readSpec();
  if (fromSpec.length > 0) {
    ok(`${fromSpec.length} endpoints from the spec`);
  } else {
    info("No OpenAPI or llms.txt published. Falling back to the docs pages.");
  }

  /* B ---------------------------------------------------------------- */

  console.log("\n2. Documentation pages\n");
  const fromDocs = fromSpec.length > 0 ? [] : await readDocs();
  if (fromDocs.length > 0) {
    ok(`${fromDocs.length} endpoint-shaped strings scraped`);
  } else if (fromSpec.length > 0) {
    info("Skipped — the spec above is better than anything scraped.");
  } else {
    bad("Nothing found in the documentation either.");
    info(`If ${DOCS_ORIGIN} needs a login, sign in and try again, or set`);
    info("SEARCHATLAS_DOCS_URL to the API reference URL you can see.");
  }

  const discovered = [...new Set([...fromSpec, ...fromDocs])];

  if (discovered.length > 0) {
    dump(
      `all discovered endpoints (${discovered.length})`,
      discovered.sort().join("\n"),
      60,
    );
  }

  /* C ---------------------------------------------------------------- */

  console.log("\n3. Verifying against the live API\n");
  info("Only endpoints whose name matches a capability we need are tried.");

  const resolved: Partial<Record<Capability, Attempt>> = {};

  for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
    const spec = CAPABILITIES[capability];
    console.log(`\n  ${spec.label}`);

    const matching = discovered.filter((url) => spec.match.test(url));
    if (matching.length === 0) {
      info(
        discovered.length > 0
          ? "nothing documented matches — falling back to guesses"
          : "nothing discovered — trying guesses across every service host",
      );
    }

    // Guesses are appended rather than substituted: a documented endpoint that
    // fails to answer should not stop the sweep from finding a working one.
    const candidates = [...matching, ...spec.fallback];
    const attempt = await verify(apiKey, capability, candidates);
    if (attempt) {
      resolved[capability] = attempt;
      if (attempt.status < 300) dump(`${capability} response`, attempt.body);
    } else {
      bad("no candidate answered");
    }
  }

  /* Output ------------------------------------------------------------ */

  console.log("\n4. Configuration\n");

  const working = (Object.keys(resolved) as Capability[]).filter(
    (c) => resolved[c]!.status < 300,
  );

  if (working.length > 0) {
    console.log("  Paste into apps/worker/.env:\n");
    for (const capability of working) {
      const attempt = resolved[capability]!;
      console.log(
        `  ${CAPABILITIES[capability].envVar}="${attempt.method} ${attempt.url}"`,
      );
    }
    console.log("");
  }

  const missing = (Object.keys(CAPABILITIES) as Capability[]).filter(
    (c) => !resolved[c] || resolved[c]!.status >= 300,
  );

  if (missing.length === 0) {
    ok("All four capabilities answered. Keyword research is fully wired.");
  } else {
    console.log(`  Still unresolved: ${missing.join(", ")}\n`);
    if (missing.includes("rankedKeywords")) {
      info("rankedKeywords is the one worth chasing: without it there is no");
      info("content gap at all, not merely a missing column.");
    }
    info("Send this whole output — the adapter can be corrected from it.");
    info("The discovered-endpoints list above is the most useful part.");
  }
  console.log("");
}

main().catch((error) => {
  console.error("\n  Probe failed:", error instanceof Error ? error.message : error);
  console.error("\n  Send this output along — correcting the endpoints is what");
  console.error("  the probe is for.\n");
  process.exit(1);
});
