import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./prompts.js";

const here = dirname(fileURLToPath(import.meta.url));

let cachedPlaybook: string | undefined;

/**
 * The 2026 SEO playbook, injected into every generation prompt and used as the
 * QA checklist. Read from `content/playbook.md` so a strategist can tune how
 * the system writes without touching code.
 */
export function loadPlaybook(): string {
  cachedPlaybook ??= readFileSync(
    join(here, "..", "content", "playbook.md"),
    "utf8",
  );
  return cachedPlaybook;
}

/** Test seam — lets a caller substitute the playbook text. */
export function setPlaybook(text: string): void {
  cachedPlaybook = text;
}
