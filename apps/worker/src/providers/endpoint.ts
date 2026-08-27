/**
 * Endpoint overrides that can move a call to another host, or change its verb.
 *
 * Its own module, with no imports, so tests and probes can exercise the parsing
 * without pulling in the worker's global config — importing a provider for one
 * pure function would otherwise demand APP_URL and a database.
 */

export type HttpMethod = "GET" | "POST";

export type Endpoint = { url: string; method: HttpMethod };

/**
 * Parses an endpoint override against a fallback.
 *
 * Accepts, in order of how much it pins down:
 *
 *   /api/v2/keywords/overview                       path on the fallback's host
 *   https://keyword.searchatlas.com/api/v2/…        another host entirely
 *   GET https://keyword.searchatlas.com/api/v2/…    host and verb
 *
 * The last form is what `pnpm searchatlas:probe` prints. The verb is included
 * because it is exactly as easy to get wrong as the path, and just as invisible
 * when it is: a wrong verb answers 405, which reads like a missing endpoint.
 *
 * A bare path hangs off the fallback's own origin rather than a configured
 * base URL — the fallback is where that endpoint would otherwise have gone, so
 * it is the right host to inherit.
 */
export function parseEndpoint(value: string, fallback: Endpoint): Endpoint {
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  const withVerb = /^(GET|POST)\s+(.+)$/i.exec(trimmed);
  const method = withVerb
    ? (withVerb[1]!.toUpperCase() as HttpMethod)
    : fallback.method;
  const target = (withVerb ? withVerb[2]! : trimmed).trim();

  if (/^https?:\/\//i.test(target)) return { url: target, method };

  let origin: string;
  try {
    origin = new URL(fallback.url).origin;
  } catch {
    // A malformed fallback is a programming error, not user input; returning
    // the override unresolved makes the eventual failure name the real value.
    return { url: target, method };
  }

  return {
    url: `${origin}${target.startsWith("/") ? "" : "/"}${target}`,
    method,
  };
}
