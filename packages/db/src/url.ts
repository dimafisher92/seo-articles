/**
 * Strips connection-string parameters that libpq understands and the server
 * does not.
 *
 * Neon's Connect dialog hands out a string ending
 * `?sslmode=require&channel_binding=require`. `channel_binding` is a libpq
 * *client* option — it tells the C client how to authenticate, and there is no
 * server setting by that name. postgres-js does not consume it, so it forwards
 * anything it does not recognise as a startup parameter, and Postgres answers:
 *
 *     unrecognized configuration parameter "channel_binding"
 *
 * which names neither the connection string nor the parameter's origin. The
 * string is copied from a provider's own UI, so the fix belongs here rather
 * than in an instruction to hand-edit every string anyone ever pastes.
 *
 * A denylist, not an allowlist: real server settings (`application_name`,
 * `options`, `search_path`) must keep working, and only this specific family of
 * client-side options is the problem.
 */
const CLIENT_ONLY_PARAMS = new Set([
  "channel_binding",
  "fallback_application_name",
  "gssdelegation",
  "gssencmode",
  "gsslib",
  "krbsrvname",
  "load_balance_hosts",
  "passfile",
  "requirepeer",
  "service",
  "sslcert",
  "sslcompression",
  "sslcrl",
  "sslcrldir",
  "sslkey",
  "sslpassword",
  "sslsni",
  "ssl_max_protocol_version",
  "ssl_min_protocol_version",
  "tcp_user_timeout",
]);

/**
 * `sslrootcert=system` is meaningful to postgres-js; any other value is a file
 * path only libpq can read.
 */
function dropsSslRootCert(value: string): boolean {
  return value !== "system";
}

export function sanitizeConnectionString(url: string): string {
  // Passwords can contain characters that make `new URL()` throw, and a
  // connection string is too important to lose to a parse error — if it cannot
  // be parsed it is passed through untouched and the driver reports the real
  // problem.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    const drop = CLIENT_ONLY_PARAMS.has(key)
      ? true
      : key === "sslrootcert"
        ? dropsSslRootCert(parsed.searchParams.get(key) ?? "")
        : false;

    if (drop) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }

  return changed ? parsed.toString() : url;
}
