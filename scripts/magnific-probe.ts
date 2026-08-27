/**
 * Verifies the Magnific REST adapter against the live API.
 *
 * The adapter's paths and request bodies come from Magnific's published API
 * reference, but could never be exercised where this code was written — the
 * network there blocks `api.magnific.com`. This script closes that gap from a
 * machine that *can* reach it: it runs the whole round trip, prints exactly
 * what came back, and says whether the shipping code understood it.
 *
 * Run it once before the first real generation. A field-name difference then
 * surfaces in two minutes, rather than part-way through writing an article.
 *
 *   pnpm magnific:probe                 # default model, asks before spending
 *   pnpm magnific:probe --model mystic
 *   pnpm magnific:probe --yes           # skip the confirmation
 */

import { createInterface } from "node:readline/promises";

import { config as loadEnv } from "dotenv";
import { imageSpecForRole, type GenerateImageRequest } from "@seo/shared";

import {
  authHeaderFor,
  findString,
  IMAGE_URL_KEYS,
  MagnificProvider,
  MODELS,
  resolveModel,
  TASK_ID_KEYS,
} from "../apps/worker/src/providers/magnific.js";

// The key lives in the worker's env file, same as the worker reads it. Passing
// it as an argument would leave it in the shell history.
loadEnv({ path: "apps/worker/.env" });

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const assumeYes = args.includes("--yes") || args.includes("-y");

const HOSTS = [
  process.env.MAGNIFIC_BASE_URL,
  "https://api.magnific.com",
  "https://api.freepik.com",
].filter((host, index, all): host is string =>
  Boolean(host) && all.indexOf(host) === index,
);

const ok = (m: string): void => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m: string): void => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
const info = (m: string): void => console.log(`    ${m}`);

function dump(label: string, value: unknown): void {
  console.log(`\n  ── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  console.log(
    JSON.stringify(value, null, 2)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  console.log("");
}

async function confirm(question: string): Promise<boolean> {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${question} [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  console.log("\nMagnific API probe\n");

  const apiKey = process.env.MAGNIFIC_API_KEY?.trim();
  if (!apiKey) {
    bad("MAGNIFIC_API_KEY is not set in apps/worker/.env");
    info("Add it there, or run `pnpm run configure`, then try again.");
    process.exit(1);
  }
  ok(`key loaded (${apiKey.slice(0, 4)}…${apiKey.slice(-4)})`);

  const modelSlug = flag("model") ?? process.env.MAGNIFIC_IMAGE_MODEL;
  let model;
  try {
    model = resolveModel(modelSlug);
  } catch (error) {
    bad(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  ok(`model: ${model.label} — ${model.path}`);
  info(`cost: ${model.costNote}`);

  /* 1 — which host answers ------------------------------------------------ */

  console.log("\n1. Reachability\n");

  let baseUrl: string | undefined;
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}${model.path}`, {
        method: "POST",
        headers: {
          [authHeaderFor(host)]: apiKey,
          "content-type": "application/json",
        },
        // Deliberately invalid: this asks the server to reject it, which proves
        // the route exists and the key is accepted without spending credits.
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000),
      });

      const text = await response.text().catch(() => "");

      if (response.status === 404) {
        bad(`${host} — 404, this path does not exist here`);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        // A 403 is ambiguous: it can be the key, but a corporate proxy or
        // egress filter sitting in front of the host answers the same way.
        // The body usually says which, so it is always printed.
        bad(
          `${host} — ${response.status}, rejected. Either the key, or ` +
            "something between you and the host.",
        );
        info(text.slice(0, 200));
        continue;
      }

      // 400/422 is the good outcome: routed, authenticated, body invalid.
      ok(`${host} — ${response.status}, route exists and key accepted`);
      info(`header used: ${authHeaderFor(host)}`);
      if (text) info(`server said: ${text.slice(0, 160)}`);
      baseUrl = host;
      break;
    } catch (error) {
      bad(`${host} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!baseUrl) {
    console.log("\n  No host accepted the request. Nothing further to test.");
    info("Every host 404 → the model path is wrong for your plan.");
    info("Every host 401 → the key is wrong or has no API access.");
    info("Every host 403 with a blocklist message → your network, not Magnific.");
    process.exit(1);
  }

  /* 2 — one real generation ----------------------------------------------- */

  console.log("\n2. Generation\n");
  info("This spends credits: one image at the cheapest resolution.");

  if (!(await confirm("Generate a test image?"))) {
    console.log("\n  Stopped before spending anything.\n");
    return;
  }

  const spec = imageSpecForRole("inline");
  const request: GenerateImageRequest = {
    prompt:
      "A single ripe banana on a plain light grey studio background, " +
      "soft even lighting, centred, product photography.",
    aspectRatio: spec.aspectRatio,
    resolution: "1k",
  };

  dump("request body the adapter builds", model.buildBody(request));

  const provider = new MagnificProvider(apiKey, baseUrl, modelSlug);

  // Raw round trip first, so the response shape is visible even when the
  // adapter's field extraction misses.
  const created = await provider.request(
    "POST",
    model.path,
    model.buildBody(request),
  );
  dump("POST response", created);

  const taskId = findString(created, TASK_ID_KEYS);
  if (taskId) {
    ok(`task id found: ${taskId}`);
  } else {
    bad(`no task id — the adapter looks for: ${TASK_ID_KEYS.join(", ")}`);
    console.log("\n  Send the POST response above and the adapter can be fixed.\n");
    process.exit(1);
  }

  /* 3 — polling ------------------------------------------------------------ */

  console.log("\n3. Polling\n");

  const started = Date.now();
  let finalTask: unknown;

  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const task = await provider.request("GET", `${model.path}/${taskId}`);
    const status = findString(task, ["status", "state"]) ?? "(no status field)";
    info(`${attempt}. ${Math.round((Date.now() - started) / 1000)}s — ${status}`);

    const upper = status.toUpperCase();
    if (["COMPLETED", "SUCCESS", "DONE", "FAILED", "ERROR"].includes(upper)) {
      finalTask = task;
      break;
    }
    if (attempt === 1) dump("first poll response", task);
  }

  if (!finalTask) {
    bad("the task never reached a terminal status");
    process.exit(1);
  }

  dump("final task", finalTask);

  const imageUrl = findString(finalTask, IMAGE_URL_KEYS);
  if (imageUrl) {
    ok(`image URL found: ${imageUrl.slice(0, 100)}`);
  } else {
    bad(`no image URL — the adapter looks for: ${IMAGE_URL_KEYS.join(", ")}`);
    console.log("\n  Send the final task above and the adapter can be fixed.\n");
    process.exit(1);
  }

  /* 4 — the shipping code path -------------------------------------------- */

  console.log("\n4. The adapter itself\n");
  info("Running MagnificProvider.generate() — the same code the worker uses.");

  if (await confirm("This generates a second image. Run it?")) {
    const result = await provider.generate(request);
    ok(`generate() returned taskId=${result.taskId}`);
    ok(`generate() returned url=${result.url.slice(0, 100)}`);
  } else {
    info("Skipped. Steps 1-3 already show the adapter's parsing works.");
  }

  console.log(`
  ────────────────────────────────────────────────────────────
  Verdict: the adapter is compatible with the live API.

  Model:  ${model.label}
  Host:   ${baseUrl}
  Header: ${authHeaderFor(baseUrl)}

  Other models available: ${Object.keys(MODELS).join(", ")}
  Set MAGNIFIC_IMAGE_MODEL in apps/worker/.env to change.
  ────────────────────────────────────────────────────────────
`);
}

main().catch((error) => {
  console.error("\n  Probe failed:", error instanceof Error ? error.message : error);
  console.error(
    "\n  Send this output along and the adapter can be corrected — that is " +
      "what the probe is for.\n",
  );
  process.exit(1);
});
