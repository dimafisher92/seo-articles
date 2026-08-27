import { and, eq, inArray } from "drizzle-orm";

import {
  brandAssets,
  brandVaults,
  clients,
  getDb,
  type BrandAsset,
  type Client,
} from "@seo/db";
import type { BrandContext } from "@seo/playbook";

/**
 * Direct database access for the worker.
 *
 * Queue coordination goes through the app's HTTP endpoints, but domain data —
 * hundreds of keyword rows, a full article body — is written straight to
 * Postgres. Pushing that through HTTP would hit Vercel's body limits and add a
 * hop for no benefit; the worker already holds the connection string.
 */

export const db = getDb;

export type ClientWithVault = {
  client: Client;
  vault: typeof brandVaults.$inferSelect | null;
  styleReference: BrandAsset | null;
};

export async function loadClient(clientId: string): Promise<ClientWithVault> {
  const [client] = await db()
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const [vault] = await db()
    .select()
    .from(brandVaults)
    .where(eq(brandVaults.clientId, clientId))
    .limit(1);

  const [styleReference] = await db()
    .select()
    .from(brandAssets)
    .where(
      and(
        eq(brandAssets.clientId, clientId),
        eq(brandAssets.isStyleReference, true),
      ),
    )
    .limit(1);

  return {
    client,
    vault: vault ?? null,
    styleReference: styleReference ?? null,
  };
}

export async function loadBrandAssets(clientId: string): Promise<BrandAsset[]> {
  return db()
    .select()
    .from(brandAssets)
    .where(eq(brandAssets.clientId, clientId));
}

export async function loadBrandAssetsByIds(
  ids: string[],
): Promise<Map<string, BrandAsset>> {
  if (ids.length === 0) return new Map();
  const rows = await db()
    .select()
    .from(brandAssets)
    .where(inArray(brandAssets.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Shapes client + vault into the context block every prompt carries. */
export function toBrandContext(loaded: ClientWithVault): BrandContext {
  const { client, vault } = loaded;
  return {
    clientName: client.name,
    domain: client.domain,
    locale: client.locale,
    country: client.country,
    businessDescription: vault?.businessDescription ?? null,
    productsServices: vault?.productsServices ?? null,
    icpAudience: vault?.icpAudience ?? null,
    toneOfVoice: vault?.toneOfVoice ?? null,
    usps: vault?.usps ?? [],
    brandTerms: vault?.brandTerms ?? [],
    bannedWords: vault?.bannedWords ?? [],
    competitors: vault?.competitors ?? [],
    ctaTargets: vault?.ctaTargets ?? [],
    ...(vault?.authorPersona ? { authorPersona: vault.authorPersona } : {}),
    siteCrawlSummary: vault?.siteCrawlSummary ?? null,
    contentGuidelines: vault?.contentGuidelines ?? null,
  };
}
