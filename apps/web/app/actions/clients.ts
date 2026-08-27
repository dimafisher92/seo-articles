"use server";

import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { brandVaults, clients, type Client } from "@seo/db";
import { normaliseDomain } from "@seo/shared";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncClientsFromNotion, type SyncResult } from "@/lib/notion";
import { enqueue } from "@/lib/queue";

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Turns a thrown error into a message the UI can render. */
async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function listClients(): Promise<Client[]> {
  await requireUser();
  return db()
    .select()
    .from(clients)
    .where(isNull(clients.archivedAt))
    .orderBy(desc(clients.status), clients.name);
}

export async function getClient(id: string): Promise<Client | null> {
  await requireUser();
  const [client] = await db()
    .select()
    .from(clients)
    .where(eq(clients.id, id))
    .limit(1);
  return client ?? null;
}

export async function createClient(input: {
  name: string;
  domain: string;
  country?: string;
  locale?: string;
}): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await requireUser();

    const name = input.name.trim();
    if (!name) throw new Error("Client name is required");

    const [created] = await db()
      .insert(clients)
      .values({
        name,
        domain: input.domain ? normaliseDomain(input.domain) : null,
        country: input.country?.toUpperCase() || "US",
        locale: input.locale || "en-US",
      })
      .returning({ id: clients.id });

    if (!created) throw new Error("Could not create the client");

    // Every client gets a vault row up front, so the form has something to edit.
    await db().insert(brandVaults).values({ clientId: created.id });

    revalidatePath("/");
    return { id: created.id };
  });
}

export async function updateClient(
  id: string,
  input: { name?: string; domain?: string; country?: string; locale?: string },
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    await db()
      .update(clients)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.domain !== undefined
          ? { domain: input.domain ? normaliseDomain(input.domain) : null }
          : {}),
        ...(input.country !== undefined
          ? { country: input.country.toUpperCase() }
          : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        updatedAt: new Date(),
      })
      .where(eq(clients.id, id));

    revalidatePath(`/clients/${id}`);
  });
}

export async function archiveClient(id: string): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();
    await db()
      .update(clients)
      .set({ archivedAt: new Date() })
      .where(eq(clients.id, id));
    revalidatePath("/");
  });
}

export async function syncNotion(): Promise<ActionResult<SyncResult>> {
  return guard(async () => {
    await requireUser();
    const result = await syncClientsFromNotion();

    // Notion-created clients need a vault row too.
    const withoutVault = await db()
      .select({ id: clients.id })
      .from(clients)
      .leftJoin(brandVaults, eq(brandVaults.clientId, clients.id))
      .where(and(isNull(brandVaults.clientId), isNull(clients.archivedAt)));

    if (withoutVault.length > 0) {
      await db()
        .insert(brandVaults)
        .values(withoutVault.map((row) => ({ clientId: row.id })))
        .onConflictDoNothing();
    }

    revalidatePath("/");
    return result;
  });
}

/** Queues the site crawl that autofills the Brand Vault. */
export async function crawlClientSite(
  clientId: string,
): Promise<ActionResult<{ jobId: string }>> {
  return guard(async () => {
    await requireUser();

    const client = await getClient(clientId);
    if (!client?.domain) {
      throw new Error("Set the client's website before running a crawl");
    }

    const job = await enqueue({
      type: "crawl_site",
      clientId,
      payload: { clientId, domain: client.domain, maxPages: 20 },
    });

    revalidatePath(`/clients/${clientId}`);
    return { jobId: job.id };
  });
}
