/**
 * Placing images in an article body, and keeping the body honest about them.
 *
 * Shared rather than living in the worker's pipeline because two places do
 * this and they must agree: assembly puts images in when an article is
 * generated, and regeneration has to put a replacement in the same spot. When
 * regeneration had its own logic it did a plain string substitution of one URL
 * for another, which only worked while the body happened to hold exactly the
 * URL the database had — one intervening run and it silently did nothing.
 */

export type PlacedImage = {
  id: string;
  role: "hero" | "inline";
  position: number;
  blobUrl: string;
  altText: string;
  caption: string | null;
  placementHeading: string | null;
};

/** Markdown for one image, with its caption as the line beneath. */
function render(image: PlacedImage): string {
  const alt = image.altText.replace(/[[\]]/g, "");
  const figure = `![${alt}](${image.blobUrl})`;
  return image.caption ? `${figure}\n*${image.caption}*` : figure;
}

/** Matches an image line, and the italic caption line that may follow it. */
const IMAGE_LINE = /^!\[[^\]]*\]\(([^)]*)\)\s*$/;

/**
 * Removes image markdown that no longer corresponds to a live image.
 *
 * The case that made this necessary: a Blob store was replaced, and every URL
 * an earlier run had written into the body pointed at the old one. They render
 * as broken images with the alt text showing — a body confidently referring to
 * pictures that no longer exist anywhere.
 *
 * Captions are dropped with their image; an italic line orphaned from the
 * figure it described is worse than no line.
 */
export function stripUnknownImages(bodyMdx: string, keepUrls: Set<string>): string {
  const lines = bodyMdx.split("\n");
  const out: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = IMAGE_LINE.exec(line.trim());

    if (match && !keepUrls.has(match[1] ?? "")) {
      // Its caption, if it has one.
      const next = lines[index + 1]?.trim() ?? "";
      if (/^\*[^*].*\*$/.test(next)) index += 1;
      // And a blank line left where the figure was.
      if ((lines[index + 1] ?? "").trim() === "") index += 1;
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

/** Every image URL the body currently references. */
export function imageUrlsIn(bodyMdx: string): string[] {
  return [...bodyMdx.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!);
}

/**
 * Puts the given images into the body, each at its intended place.
 *
 * The hero goes under the H1; an inline image goes under the heading it was
 * planned for. An image whose heading was renamed during revision is appended
 * rather than dropped — it was paid for, and a human can move it.
 *
 * Images already present in the body are left where they are, so running this
 * twice does not duplicate them.
 */
export function placeImages(bodyMdx: string, images: PlacedImage[]): string {
  if (images.length === 0) return bodyMdx;

  const present = new Set(imageUrlsIn(bodyMdx));
  const missing = images.filter((image) => !present.has(image.blobUrl));
  if (missing.length === 0) return bodyMdx;

  const lines = bodyMdx.split("\n");
  const out: string[] = [];
  const placed = new Set<string>();

  const hero = missing.find((image) => image.role === "hero");
  const inline = missing.filter((image) => image.role !== "hero");

  let heroPlaced = false;

  for (const line of lines) {
    const headingMatch = /^(#{2,3})\s+(.*\S)\s*$/.exec(line);
    if (headingMatch?.[2]) {
      const heading = headingMatch[2].trim().toLowerCase();
      for (const image of inline) {
        if (placed.has(image.id)) continue;
        if (image.placementHeading?.trim().toLowerCase() === heading) {
          out.push(render(image), "");
          placed.add(image.id);
        }
      }
    }

    out.push(line);

    if (!heroPlaced && hero && /^#\s+/.test(line)) {
      out.push("", render(hero));
      placed.add(hero.id);
      heroPlaced = true;
    }
  }

  // A hero with no H1 to anchor to, or an inline image whose heading was
  // renamed during revision: kept rather than silently losing a paid render.
  const orphans = missing.filter((image) => !placed.has(image.id));
  if (orphans.length > 0) {
    if (hero && !heroPlaced) {
      out.unshift(render(hero), "");
      placed.add(hero.id);
    }
    for (const image of orphans) {
      if (placed.has(image.id)) continue;
      out.push("", render(image));
    }
  }

  return out.join("\n");
}

/**
 * Makes the body agree with the images that actually exist.
 *
 * One operation rather than two so callers cannot do half of it: drop what no
 * longer exists, then place what is missing. Idempotent — running it on its own
 * output changes nothing.
 */
export function reconcileImages(
  bodyMdx: string,
  images: PlacedImage[],
): string {
  const live = new Set(images.map((image) => image.blobUrl));
  return placeImages(stripUnknownImages(bodyMdx, live), images);
}
