/** Timestamped console logging. The worker runs attended in a terminal. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? LEVELS.info;

function emit(level: Level, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
