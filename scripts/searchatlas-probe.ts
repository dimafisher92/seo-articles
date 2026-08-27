/**
 * Reads SearchAtlas's API catalogue with the key you already have.
 *
 * The first version of this script swept guessed REST paths and found nothing.
 * Two things explain why, and both came out of SearchAtlas's own published npm
 * bridge (`searchatlas-mcp-server`) rather than from documentation:
 *
 *   1. Their programmatic surface lives at `https://mcp.searchatlas.com/mcp`,
 *      not at documented REST routes. Their bridge hard-codes no paths at all —
 *      it forwards everything to that one endpoint.
 *   2. The same `SEARCHATLAS_API_KEY` authenticates there, as `X-API-Key`. No
 *      second credential, no login flow.
 *
 * The happy consequence: the API describes itself. `tools/list` returns every
 * tool with its input schema, so this script does not have to guess and does not
 * need the documentation — which is why it could be written from a machine that
 * cannot reach either.
 *
 * It prints the tools matching what the pipeline needs and writes the whole
 * catalogue to a file, because several hundred tools do not fit in a terminal
 * scrollback worth reading.
 *
 *   pnpm searchatlas:probe
 *   pnpm searchatlas:probe --grep backlink
 *   pnpm searchatlas:probe --call se_x --args '{"domain":"nike.com"}'
 */

import { writeFileSync } from "node:fs";

import { config as loadEnv } from "dotenv";

import {
  McpHttpClient,
  unwrapToolResult,
  type McpTool,
} from "../apps/worker/src/providers/mcp-http.js";

// The key lives in the worker's env file, same as the worker reads it. Passing
// it as an argument would leave it in the shell history.
loadEnv({ path: "apps/worker/.env" });

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const MCP_URL =
  process.env.SEARCHATLAS_MCP_URL ?? "https://mcp.searchatlas.com/mcp";

const CATALOGUE_FILE = "searchatlas-tools.json";

const ok = (m: string): void => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m: string): void => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
const info = (m: string): void => console.log(`    ${m}`);

/**
 * What the pipeline needs, and how to recognise it among hundreds of tools.
 *
 * Deliberately loose: the point is to surface candidates for a person to
 * confirm, never to wire something up on a regex's say-so.
 */
const NEEDS = [
  {
    label: "keyword metrics — volume, difficulty, CPC",
    match: /keyword/i,
    andMatch: /volume|difficult|metric|overview|magic|research|explor/i,
  },
  {
    label: "related keywords / ideas",
    match: /keyword/i,
    andMatch: /related|idea|suggest|similar|expand|question/i,
  },
  {
    label: "ranked keywords for a domain — this is what finds content gaps",
    match: /^se_|site.?explorer|domain|competitor/i,
    andMatch: /keyword|organic|rank|position/i,
  },
  {
    label: "SERP results",
    match: /serp|search.?result/i,
    andMatch: /./,
  },
] as const;

function summarise(tool: McpTool): string {
  const schema = tool.inputSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;

  const required = schema?.required ?? [];
  const optional = Object.keys(schema?.properties ?? {}).filter(
    (key) => !required.includes(key),
  );

  const params = [
    ...required.map((key) => `${key}*`),
    ...optional.slice(0, 8),
    ...(optional.length > 8 ? [`+${optional.length - 8} more`] : []),
  ];

  return params.length > 0 ? `(${params.join(", ")})` : "(no parameters)";
}

function show(tool: McpTool, indent = "    "): void {
  console.log(`${indent}${tool.name} ${summarise(tool)}`);
  if (tool.description) console.log(`${indent}  ${tool.description.slice(0, 150)}`);
}

async function main(): Promise<void> {
  console.log("\nSearchAtlas catalogue\n");

  const token = process.env.SEARCHATLAS_TOKEN?.trim();
  const apiKey = process.env.SEARCHATLAS_API_KEY?.trim();

  if (!token && !apiKey) {
    bad("Neither SEARCHATLAS_TOKEN nor SEARCHATLAS_API_KEY is set");
    info("Add SEARCHATLAS_API_KEY to apps/worker/.env, or run `pnpm run configure`.");
    process.exit(1);
  }

  // Bearer first, matching SearchAtlas's own bridge; the API key is their
  // documented alternative and the one this project already asks for.
  const authHeaders = token
    ? { authorization: `Bearer ${token}` }
    : { "x-api-key": apiKey! };

  ok(
    token
      ? `token ${token.slice(0, 6)}… (Authorization: Bearer)`
      : `key ${apiKey!.slice(0, 6)}… (X-API-Key)`,
  );
  info(`endpoint: ${MCP_URL}`);

  const client = new McpHttpClient(MCP_URL, authHeaders);

  /* 1 — handshake --------------------------------------------------------- */

  console.log("\n1. Connecting\n");

  let tools: McpTool[];
  try {
    const server = await client.connect();
    ok(`connected${server.name ? ` — ${server.name} ${server.version ?? ""}` : ""}`);

    tools = await client.listTools();
    ok(`${tools.length} tools in the catalogue`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bad(message);
    if (/401|403/.test(message)) {
      info("The key was rejected. Check it in Dashboard → API Settings, and");
      info("that your plan includes API access.");
    } else {
      info(`If this is a network error, check that this machine can reach ${MCP_URL}`);
    }
    process.exit(1);
  }

  writeFileSync(CATALOGUE_FILE, JSON.stringify(tools, null, 2), "utf8");
  ok(`full catalogue written to ${CATALOGUE_FILE}`);

  /* 2 — free-text search -------------------------------------------------- */

  const grep = flag("grep");
  if (grep) {
    console.log(`\n2. Tools matching "${grep}"\n`);
    const pattern = new RegExp(grep, "i");
    const hits = tools.filter(
      (t) => pattern.test(t.name) || pattern.test(t.description ?? ""),
    );
    if (hits.length === 0) bad("nothing matched");
    for (const tool of hits.slice(0, 40)) show(tool, "  ");
    if (hits.length > 40) info(`… and ${hits.length - 40} more`);
    console.log("");
    return;
  }

  /* 3 — what the pipeline needs ------------------------------------------- */

  console.log("\n2. Candidates for what the pipeline needs\n");
  info("Names only — nothing gets wired up from a regex match.");

  const prefixes = new Map<string, number>();
  for (const tool of tools) {
    const prefix = /^([a-z]+)_/i.exec(tool.name)?.[1] ?? "(none)";
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  const byCount = [...prefixes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([prefix, count]) => `${prefix} (${count})`);

  console.log(`\n  Prefixes: ${byCount.join(", ")}\n`);

  for (const need of NEEDS) {
    console.log(`\n  ${need.label}`);

    const hits = tools.filter(
      (tool) =>
        (need.match.test(tool.name) || need.match.test(tool.description ?? "")) &&
        (need.andMatch.test(tool.name) ||
          need.andMatch.test(tool.description ?? "")),
    );

    if (hits.length === 0) {
      bad("nothing in the catalogue looks like this");
      continue;
    }

    for (const tool of hits.slice(0, 8)) show(tool);
    if (hits.length > 8) info(`  … and ${hits.length - 8} more`);
  }

  /* 4 — try one call ------------------------------------------------------ */

  const toolName = flag("call");
  if (toolName) {
    console.log(`\n3. Calling ${toolName}\n`);
    try {
      const result = await client.callTool(
        toolName,
        JSON.parse(flag("args") ?? "{}") as Record<string, unknown>,
      );
      console.log(JSON.stringify(unwrapToolResult(result), null, 2).slice(0, 4000));
    } catch (error) {
      bad(error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`
  ────────────────────────────────────────────────────────────
  Next: send ${CATALOGUE_FILE}, or just the candidate names above.

  Ranked keywords for a domain is the one that matters most —
  without it there is no content gap at all, not merely a
  missing column.

  To look around yourself:
    pnpm searchatlas:probe --grep backlink
    pnpm searchatlas:probe --call <name> --args '{"domain":"nike.com"}'
  ────────────────────────────────────────────────────────────
`);
}

main().catch((error) => {
  console.error("\n  Probe failed:", error instanceof Error ? error.message : error);
  console.error("\n  Send this output along — that is what the probe is for.\n");
  process.exit(1);
});
