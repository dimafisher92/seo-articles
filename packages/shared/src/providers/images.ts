/**
 * Image-generation provider boundary. Magnific is the first implementation.
 */

export type AspectRatio =
  | "16:9"
  | "4:3"
  | "3:2"
  | "1:1"
  | "3:4"
  | "9:16";

export type ImageResolution = "1k" | "2k" | "4k";

export type GenerateImageRequest = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  /**
   * A brand asset URL. The provider uses it to match the client's visual
   * language — this is what stops generated art looking generic.
   */
  styleReferenceUrl?: string;
  /** 0-1; how tightly to follow the style reference. */
  styleStrength?: number;
  /** Composition reference, e.g. a product shot to echo the layout of. */
  structureReferenceUrl?: string;
  structureStrength?: number;
};

export type GeneratedImage = {
  /** Provider-side task id, stored so a stuck job can be traced. */
  taskId: string;
  /** Temporary URL — callers must copy the bytes to durable storage. */
  url: string;
  width?: number;
  height?: number;
};

export interface ImageProvider {
  readonly name: string;
  generate(request: GenerateImageRequest): Promise<GeneratedImage>;
}

/** Hero images are wide; in-body images are shallower so they do not dominate. */
export function imageSpecForRole(role: "hero" | "inline"): {
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
} {
  return role === "hero"
    ? { aspectRatio: "16:9", resolution: "2k" }
    : { aspectRatio: "3:2", resolution: "1k" };
}
