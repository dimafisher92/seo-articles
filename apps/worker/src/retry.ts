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

/**
 * A Claude subscription that has run out for now.
 *
 * Told apart from every other failure because the response to it is different
 * in kind: there is nothing wrong with the job, and nothing to fix. It will
 * succeed unchanged once the window resets, so retrying in sixty seconds and
 * spending the job's attempts is the one thing not to do.
 *
 * The phrase arrives as the assistant's own text — "You've hit your limit ·
 * resets 7:20pm (Europe/Berlin)" — not in any error field, which is why nine
 * attempts across three jobs went into a wall that opens at 19:20 and reported
 * `error_max_turns` each time.
 */
const USAGE_LIMIT_PATTERN =
  /hit your (?:usage )?limit|usage limit reached|out of (?:usage|credits)|limit .{0,20}resets/i;

export function isUsageLimit(text: string): boolean {
  return USAGE_LIMIT_PATTERN.test(text);
}

/**
 * How long to wait, read from the message that announced the limit.
 *
 * "resets 7:20pm (Europe/Berlin)" carries a wall-clock time and the zone it is
 * in, so the wait is computed in that zone rather than from an offset we would
 * have to guess. Returns null when the message says nothing useful — the
 * caller then falls back to a fixed wait, which is right more often than a
 * number invented here.
 */
export function minutesUntilReset(text: string, now: Date = new Date()): number | null {
  const time = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!time) return null;

  const zone = /\(([A-Za-z]+\/[A-Za-z_]+)\)/.exec(text)?.[1];

  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  const meridiem = time[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const here = nowInZone(now, zone);
  if (!here) return null;

  let minutes = (hour * 60 + minute) - (here.hour * 60 + here.minute);
  // A reset time already past today is tomorrow's.
  if (minutes <= 0) minutes += 24 * 60;

  return minutes;
}

/** The wall-clock time in a named zone, without doing offset arithmetic. */
function nowInZone(
  now: Date,
  zone: string | undefined,
): { hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(zone ? { timeZone: zone } : {}),
    }).formatToParts(now);

    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour: hour % 24, minute };
  } catch {
    // An unknown zone name is not worth failing over; the caller has a default.
    return null;
  }
}
