import type {
  GenerateImageRequest,
  GeneratedImage,
  ImageProvider,
} from "@seo/shared";

import { config } from "../config.js";
import { log } from "../log.js";
import { sleep } from "../claude.js";

/**
 * Magnific (Mystic) implementation of the image provider.
 *
 * Confirmed shape: `POST /v1/ai/mystic` with an `x-magnific-api-key` header
 * returns a `task_id`; the caller polls until the task reports COMPLETED and
 * reads the image URL off the finished task. Generation runs 10-20s at 1K and
 * 20-40s at 2K, so polling is the expected pattern rather than a workaround.
 *
 * The returned URL is temporary. Callers must copy the bytes into durable
 * storage — `ingestImage()` in api.ts does that via the app.
 */

const MYSTIC_PATH = process.env.MAGNIFIC_PATH_MYSTIC ?? "/v1/ai/mystic";

/** Polling budget: generous enough for a 4K render, short of hanging a job. */
const POLL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;

type Json = Record<string, unknown>;

function findString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const obj = value as Json;
  for (const key of keys) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate) && typeof candidate[0] === "string") {
      return candidate[0];
    }
  }
  for (const nested of Object.values(obj)) {
    const found = findString(nested, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

export class MagnificProvider implements ImageProvider {
  readonly name = "magnific";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = config.magnific.baseUrl,
  ) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Json,
  ): Promise<Json> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        "x-magnific-api-key": this.apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Magnific ${method} ${path} → ${response.status} ${response.statusText}. ${text.slice(0, 400)}`,
      );
    }
    return (await response.json()) as Json;
  }

  async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
    const body: Json = {
      prompt: request.prompt,
      resolution: request.resolution,
      aspect_ratio: request.aspectRatio,
      // Photographic realism suits editorial imagery; diagrams read fine too.
      engine: process.env.MAGNIFIC_ENGINE ?? "automatic",
      filter_nsfw: true,
    };

    // The style reference is what stops generated art looking like generic
    // stock — it carries the client's palette, lighting and treatment across.
    if (request.styleReferenceUrl) {
      body.style_reference = request.styleReferenceUrl;
      body.adherence = request.styleStrength ?? 0.5;
    }
    if (request.structureReferenceUrl) {
      body.structure_reference = request.structureReferenceUrl;
      body.structure_strength = request.structureStrength ?? 0.4;
    }

    const created = await this.request("POST", MYSTIC_PATH, body);
    const taskId = findString(created, ["task_id", "taskId", "id"]);
    if (!taskId) {
      throw new Error(
        `Magnific did not return a task id: ${JSON.stringify(created).slice(0, 300)}`,
      );
    }

    const url = await this.pollUntilReady(taskId);
    return { taskId, url };
  }

  private async pollUntilReady(taskId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const task = await this.request("GET", `${MYSTIC_PATH}/${taskId}`);
      const status =
        findString(task, ["status", "state"])?.toUpperCase() ?? "UNKNOWN";

      if (status === "COMPLETED" || status === "SUCCESS" || status === "DONE") {
        const url = findString(task, [
          "url",
          "image_url",
          "imageUrl",
          "generated",
          "generated_url",
          "output",
        ]);
        if (!url) {
          throw new Error(
            `Magnific task ${taskId} completed without an image URL: ` +
              `${JSON.stringify(task).slice(0, 300)}`,
          );
        }
        return url;
      }

      if (status === "FAILED" || status === "ERROR") {
        const reason =
          findString(task, ["error", "message", "reason"]) ?? "unknown reason";
        throw new Error(`Magnific task ${taskId} failed: ${reason}`);
      }
    }

    throw new Error(
      `Magnific task ${taskId} did not finish within ${POLL_TIMEOUT_MS / 1000}s`,
    );
  }
}

export function createImageProvider(): ImageProvider | null {
  const apiKey = config.magnific.apiKey;
  if (!apiKey) {
    log.warn(
      "MAGNIFIC_API_KEY is not set — articles will only use uploaded brand assets.",
    );
    return null;
  }
  return new MagnificProvider(apiKey);
}
