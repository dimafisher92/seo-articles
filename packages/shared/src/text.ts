/** Small text helpers used on both sides of the worker boundary. */

/** URL-safe slug: transliterates accents, strips punctuation, caps length. */
export function slugify(input: string, maxLength = 75): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= maxLength) return slug;
  // Cut on a word boundary rather than mid-word.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  return lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut;
}

/** Strips scheme, www and any path so domains compare reliably. */
export function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

export function isSameDomain(a: string, b: string): boolean {
  return normaliseDomain(a) === normaliseDomain(b);
}

/** Truncates on a word boundary, appending an ellipsis when it cuts. */
export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const cut = input.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Fall back to a hard cut only when the boundary is so early that keeping
  // it would throw away most of the budget.
  return `${(lastSpace > maxLength * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Pulls the first JSON object or array out of a model response.
 *
 * Even with an explicit "return only JSON" instruction, models occasionally
 * wrap output in a fenced block or add a sentence of preamble. Rather than
 * fail the whole pipeline stage on that, we scan for the first balanced
 * top-level structure. Strings and escapes are tracked so a brace inside a
 * quoted value does not throw off the depth count.
 */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = fenced?.[1]?.trim() ?? raw.trim();

  try {
    return JSON.parse(text);
  } catch {
    // fall through to scanning
  }

  const start = text.search(/[[{]/);
  if (start === -1) {
    throw new Error(`No JSON found in model output: ${text.slice(0, 200)}`);
  }

  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error(
    `Unterminated JSON in model output: ${text.slice(start, start + 200)}`,
  );
}
