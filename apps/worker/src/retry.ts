/**
 * Whether a failed stage is worth running again.
 *
 * Its own module, importing nothing, because it is worth testing directly and
 * `claude.ts` cannot be imported without the worker's whole configuration —
 * APP_URL, a worker secret, a database. The rule has been wrong in both
 * directions and each time it cost real work: a timeout marked retryable spent
 * three full-length runs reaching the same place, and `error_max_turns` marked
 * permanent threw away a finished draft and four rendered images.
 */

const RATE_LIMIT_PATTERN =
  /rate.?limit|429|overloaded|529|usage limit|quota|too many requests/i;

export function isRateLimit(message: string): boolean {
  return RATE_LIMIT_PATTERN.test(message);
}

export function isRetryableFailure(subtype: string, detail: string): boolean {
  if (isRateLimit(detail)) return true;

  switch (subtype) {
    case "error_during_execution":
      return true;
    // Twelve turns spent in twelve seconds is a stage misbehaving on this
    // attempt, not a verdict on the work. Another attempt costs seconds.
    case "error_max_turns":
      return true;
    // Five attempts at the schema are already spent inside the SDK; a sixth
    // through a fresh conversation is a whole stage paid again for the same
    // answer.
    case "error_max_structured_output_retries":
      return false;
    default:
      return false;
  }
}
