import { Client as NotionClient } from "@notionhq/client";
import { eq } from "drizzle-orm";

import { clients, type NewClient } from "@seo/db";
import { normaliseDomain } from "@seo/shared";

import { db } from "./db";
import { env } from "./env";

/**
 * One-way pull from the agency's Notion client database.
 *
 * Notion owns the roster — who is a client, their site, whether they are active.
 * The Brand Vault lives in this app and is never written back, so a sync can be
 * re-run safely without clobbering research work.
 */

type NotionProperty = Record<string, unknown>;

function readTitle(prop: NotionProperty | undefined): string | null {
  const title = (prop as { title?: { plain_text?: string }[] } | undefined)?.title;
  if (!Array.isArray(title)) return null;
  const text = title.map((t) => t.plain_text ?? "").join("").trim();
  return text || null;
}

function readUrl(prop: NotionProperty | undefined): string | null {
  const url = (prop as { url?: string | null } | undefined)?.url;
  return url?.trim() || null;
}

function readSelect(prop: NotionProperty | undefined): string | null {
  const select = (prop as { select?: { name?: string } | null } | undefined)?.select;
  return select?.name?.trim() || null;
}

/** Notion's status vocabulary → our enum. Unknown values are treated as paused. */
function mapStatus(value: string | null): "active" | "paused" | "offboarded" {
  switch (value?.toLowerCase()) {
    case "active":
      return "active";
    case "offboarded":
      return "offboarded";
    default:
      return "paused";
  }
}

export type SyncResult = {
  created: number;
  updated: number;
  skipped: { name: string; reason: string }[];
};

export async function syncClientsFromNotion(): Promise<SyncResult> {
  const notion = new NotionClient({ auth: env.notionToken });
  const databaseId = env.notionClientsDbId;

  const result: SyncResult = { created: 0, updated: 0, skipped: [] };

  let cursor: string | undefined;
  do {
    const page = await notion.databases.query({
      database_id: databaseId,
      ...(cursor ? { start_cursor: cursor } : {}),
      page_size: 100,
    });

    for (const row of page.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, NotionProperty>;

      const name = readTitle(props["Client Name"]);
      if (!name) {
        result.skipped.push({ name: row.id, reason: "no Client Name" });
        continue;
      }

      const website = readUrl(props["Website"]);
      const values: NewClient = {
        notionPageId: row.id,
        name,
        domain: website ? normaliseDomain(website) : null,
        status: mapStatus(readSelect(props["Status"])),
        serviceType: readSelect(props["Service Type"]),
        updatedAt: new Date(),
      };

      const [existing] = await db()
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.notionPageId, row.id))
        .limit(1);

      if (existing) {
        // Locale and country are set in-app per client; Notion does not carry
        // them, so they are deliberately left out of the update.
        await db()
          .update(clients)
          .set({
            name: values.name,
            domain: values.domain,
            status: values.status,
            serviceType: values.serviceType,
            updatedAt: new Date(),
          })
          .where(eq(clients.id, existing.id));
        result.updated += 1;
      } else {
        await db().insert(clients).values(values);
        result.created += 1;
      }
    }

    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return result;
}
