import {
  sleep,
  type AspectRatio,
  type GenerateImageRequest,
  type GeneratedImage,
  type ImageProvider,
} from "@seo/shared";

/**
 * Magnific image generation over the REST API.
 *
 * Magnific is the rebranded Freepik platform (April 2026). `api.magnific.com`
 * and `api.freepik.com` both work and accept the same key; only the auth header
 * name differs, which is why it is derived from the base URL rather than fixed.
 *
 * Every model is asynchronous: POST returns a task id, then the caller polls
 * until the task reports completion. Generation runs 10-20s at 1K and 20-40s at
 * 2K, so polling is the expected pattern rather than a workaround.
 *
 * The URL a finished task returns is temporary. Callers must copy the bytes
 * into durable storage — `ingestImage()` in api.ts does that via the app.
 *
 * ## Verifying against the live API
 *
 * The paths and request bodies below come from Magnific's published API
 * reference, but could not be exercised from the build environment — the proxy
 * there blocks `api.magnific.com`. Run `pnpm magnific:probe` once before the
 * first real generation: it performs the whole round trip and prints what
 * actually came back, so a field-name difference surfaces in two minutes rather
 * than part-way through writing an article.
 */

type Json = Record<string, unknown>;

/* --------------------------------------------------------- model registry */

export type ModelSpec = {
  /** Endpoint path. Polling appends `/{taskId}` to it. */
  path: string;
  label: string;
  /** Rough published cost per image, for the startup log and the docs. */
  costNote: string;
  /**
   * Builds the request body.
   *
   * Per-model rather than shared, because the models disagree about the thing
   * that matters most here: Mystic takes a bare `style_reference` URL plus an
   * adherence weight, while the Gemini-backed models take `reference_images`
   * entries carrying an image, a text description and a MIME type. Swapping
   * only the path would leave the style reference silently ignored, which is
   * exactly the feature brand consistency depends on.
   */
  buildBody(request: GenerateImageRequest): Json;
};

/** Magnific serves references by URL, but still wants the type declared. */
function mimeTypeFor(url: string): string {
  const extension = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

/**
 * Magnific names its aspect ratios rather than taking `w:h`.
 *
 * Sending "16:9" is rejected with a 400 listing the whole vocabulary — after
 * the request has been queued, which is an expensive way to learn about a
 * string. Their accepted values, verbatim from that error:
 *
 *   square_1_1, classic_4_3, traditional_3_4, widescreen_16_9,
 *   social_story_9_16, standard_3_2, portrait_2_3, horizontal_2_1,
 *   vertical_1_2, social_post_4_5
 */
const ASPECT_RATIO_NAMES: Record<AspectRatio, string> = {
  "1:1": "square_1_1",
  "4:3": "classic_4_3",
  "3:4": "traditional_3_4",
  "16:9": "widescreen_16_9",
  "9:16": "social_story_9_16",
  "3:2": "standard_3_2",
};

export function aspectRatioName(ratio: AspectRatio): string {
  const name = ASPECT_RATIO_NAMES[ratio];
  if (!name) {
    // Fails here rather than at the API, which would report it as a rejected
    // field several minutes and one queued job later.
    throw new Error(
      `No Magnific name for aspect ratio "${ratio}". Add it to ` +
        `ASPECT_RATIO_NAMES; they accept: ${Object.values(ASPECT_RATIO_NAMES).join(", ")}.`,
    );
  }
  return name;
}

/** Shared by every model; Magnific expects "1K"/"2K"/"4K". */
function common(request: GenerateImageRequest): Json {
  return {
    prompt: request.prompt,
    aspect_ratio: aspectRatioName(request.aspectRatio),
    resolution: request.resolution.toUpperCase(),
  };
}

export const MODELS: Record<string, ModelSpec> = {
  /**
   * Nano Banana 2 — Gemini 3.1 Flash. Magnific's slug for it is
   * `nano-banana-pro-flash`; there is no `nano-banana-2` path.
   */
  "nano-banana-pro-flash": {
    path: "/v1/ai/text-to-image/nano-banana-pro-flash",
    label: "Nano Banana 2 (Gemini 3.1 Flash)",
    costNote: "premium — up to ~$0.30/image at 4K",
    buildBody(request) {
      const body: Json = {
        ...common(request),
        // Editorial imagery should not be embellished with search results.
        use_google_search_tool: false,
      };

      const references: Json[] = [];
      if (request.styleReferenceUrl) {
        references.push({
          image: request.styleReferenceUrl,
          text:
            "Match the visual style of this image — its palette, lighting, " +
            "materials and overall treatment. Do not reproduce its subject.",
          mime_type: mimeTypeFor(request.styleReferenceUrl),
        });
      }
      if (request.structureReferenceUrl) {
        references.push({
          image: request.structureReferenceUrl,
          text: "Echo the composition and framing of this image.",
          mime_type: mimeTypeFor(request.structureReferenceUrl),
        });
      }
      if (references.length > 0) body.reference_images = references;

      return body;
    },
  },

  /** Magnific's own model. Middle of the range on price. */
  mystic: {
    path: "/v1/ai/mystic",
    label: "Mystic",
    costNote: "~$0.069/image at 1K",
    buildBody(request) {
      const body: Json = {
        ...common(request),
        engine: process.env.MAGNIFIC_ENGINE ?? "automatic",
        filter_nsfw: true,
      };
      if (request.styleReferenceUrl) {
        body.style_reference = request.styleReferenceUrl;
        body.adherence = request.styleStrength ?? 0.5;
      }
      if (request.structureReferenceUrl) {
        body.structure_reference = request.structureReferenceUrl;
        body.structure_strength = request.structureStrength ?? 0.4;
      }
      return body;
    },
  },

  /** The cheap option — roughly a twentieth of Nano Banana's cost. */
  "flux-dev": {
    path: "/v1/ai/text-to-image/flux-dev",
    label: "Flux Dev",
    costNote: "~$0.012/image — the cheapest of the three",
    buildBody(request) {
      const body: Json = { ...common(request) };
      if (request.styleReferenceUrl) {
        body.style_reference = request.styleReferenceUrl;
      }
      return body;
    },
  },
};

export const DEFAULT_MODEL = "nano-banana-pro-flash";
export const DEFAULT_BASE_URL = "https://api.magnific.com";

export function resolveModel(slug?: string): ModelSpec {
  const key = (slug || DEFAULT_MODEL).trim();
  const spec = MODELS[key];
  if (!spec) {
    throw new Error(
      `Unknown MAGNIFIC_IMAGE_MODEL "${key}". Available: ${Object.keys(MODELS).join(", ")}.`,
    );
  }
  return spec;
}

/** Freepik-branded hosts want their own header name; the key is the same. */
export function authHeaderFor(baseUrl: string): string {
  return /freepik\./i.test(baseUrl) ? "x-freepik-api-key" : "x-magnific-api-key";
}

/* -------------------------------------------------------------- provider */

/** Polling budget: generous enough for a 4K render, short of hanging a job. */
const POLL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * Pulls a string out of a response by trying several plausible key names at
 * any depth. Field naming is the one thing the published reference does not
 * pin down, so being tolerant here turns a naming difference into a null the
 * caller can report rather than a crash.
 */
export function findString(
  value: unknown,
  keys: string[],
  depth = 0,
): string | null {
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

export const TASK_ID_KEYS = ["task_id", "taskId", "id"];
export const IMAGE_URL_KEYS = [
  "url",
  "image_url",
  "imageUrl",
  "generated",
  "generated_url",
  "output",
];

export class MagnificProvider implements ImageProvider {
  readonly name = "magnific";
  readonly model: ModelSpec;

  /**
   * Everything is injected rather than read from global config, so this stays
   * a pure adapter — importable by the probe script without dragging in the
   * worker's own required environment.
   */
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    modelSlug?: string,
  ) {
    this.model = resolveModel(modelSlug);
  }

  async request(
    method: "GET" | "POST",
    path: string,
    body?: Json,
  ): Promise<Json> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        [authHeaderFor(this.baseUrl)]: this.apiKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const hint =
        response.status === 404
          ? " The path may be wrong for this model — run `pnpm magnific:probe` to check."
          : response.status === 401 || response.status === 403
            ? " Check MAGNIFIC_API_KEY."
            : "";
      throw new Error(
        `Magnific ${method} ${path} → ${response.status} ${response.statusText}.${hint} ${text.slice(0, 400)}`,
      );
    }
    return (await response.json()) as Json;
  }

  async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
    const created = await this.request(
      "POST",
      this.model.path,
      this.model.buildBody(request),
    );

    const taskId = findString(created, TASK_ID_KEYS);
    if (!taskId) {
      throw new Error(
        `Magnific did not return a task id. Response: ${JSON.stringify(created).slice(0, 300)}. ` +
          "Run `pnpm magnific:probe` to see the full shape.",
      );
    }

    const url = await this.pollUntilReady(taskId);
    return { taskId, url };
  }

  private async pollUntilReady(taskId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const task = await this.request("GET", `${this.model.path}/${taskId}`);
      const status =
        findString(task, ["status", "state"])?.toUpperCase() ?? "UNKNOWN";

      if (status === "COMPLETED" || status === "SUCCESS" || status === "DONE") {
        const url = findString(task, IMAGE_URL_KEYS);
        if (!url) {
          throw new Error(
            `Magnific task ${taskId} completed without an image URL: ` +
              `${JSON.stringify(task).slice(0, 300)}. ` +
              "Run `pnpm magnific:probe` to see the full shape.",
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
