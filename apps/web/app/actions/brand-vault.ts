"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";

import { brandAssets, brandVaults, type BrandAsset, type BrandVault } from "@seo/db";
import { normaliseDomain } from "@seo/shared";

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

import type { ActionResult } from "./clients";

async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getBrandVault(
  clientId: string,
): Promise<BrandVault | null> {
  await requireUser();
  const [vault] = await db()
    .select()
    .from(brandVaults)
    .where(eq(brandVaults.clientId, clientId))
    .limit(1);
  return vault ?? null;
}

export async function listBrandAssets(
  clientId: string,
): Promise<BrandAsset[]> {
  await requireUser();
  return db()
    .select()
    .from(brandAssets)
    .where(eq(brandAssets.clientId, clientId))
    .orderBy(desc(brandAssets.isStyleReference), desc(brandAssets.createdAt));
}

export type BrandVaultInput = {
  businessDescription: string;
  productsServices: string;
  icpAudience: string;
  toneOfVoice: string;
  contentGuidelines: string;
  usps: string[];
  brandTerms: string[];
  bannedWords: string[];
  competitors: string[];
  ctaTargets: { label: string; url: string; useWhen?: string }[];
  authorPersona: {
    name?: string;
    title?: string;
    bio?: string;
    credentials?: string[];
  };
};

export async function saveBrandVault(
  clientId: string,
  input: BrandVaultInput,
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    const values = {
      businessDescription: input.businessDescription.trim() || null,
      productsServices: input.productsServices.trim() || null,
      icpAudience: input.icpAudience.trim() || null,
      toneOfVoice: input.toneOfVoice.trim() || null,
      contentGuidelines: input.contentGuidelines.trim() || null,
      usps: clean(input.usps),
      brandTerms: clean(input.brandTerms),
      bannedWords: clean(input.bannedWords),
      // Competitors are matched against ranking data by hostname, so they are
      // normalised on the way in rather than at every comparison site.
      competitors: clean(input.competitors).map(normaliseDomain),
      ctaTargets: input.ctaTargets.filter((t) => t.label.trim() && t.url.trim()),
      authorPersona: input.authorPersona.name ? input.authorPersona : null,
      updatedAt: new Date(),
    };

    await db()
      .insert(brandVaults)
      .values({ clientId, ...values })
      .onConflictDoUpdate({ target: brandVaults.clientId, set: values });

    revalidatePath(`/clients/${clientId}`);
  });
}

function clean(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** Records an asset the browser has already uploaded straight to Blob. */
export async function registerBrandAsset(
  clientId: string,
  input: {
    blobUrl: string;
    pathname: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    category?: string;
  },
): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await requireUser();

    const [asset] = await db()
      .insert(brandAssets)
      .values({
        clientId,
        blobUrl: input.blobUrl,
        pathname: input.pathname,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        category: input.category ?? null,
      })
      .returning({ id: brandAssets.id });

    if (!asset) throw new Error("Could not register the asset");

    revalidatePath(`/clients/${clientId}`);
    return { id: asset.id };
  });
}

export async function updateBrandAsset(
  assetId: string,
  input: { altText?: string; category?: string; tags?: string[] },
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    const [asset] = await db()
      .update(brandAssets)
      .set({
        ...(input.altText !== undefined ? { altText: input.altText.trim() } : {}),
        ...(input.category !== undefined
          ? { category: input.category.trim() || null }
          : {}),
        ...(input.tags !== undefined ? { tags: clean(input.tags) } : {}),
      })
      .where(eq(brandAssets.id, assetId))
      .returning({ clientId: brandAssets.clientId });

    if (asset) revalidatePath(`/clients/${asset.clientId}`);
  });
}

/**
 * Marks the asset Magnific uses as its style reference.
 *
 * At most one per client, enforced by a partial unique index, so the previous
 * holder is cleared in the same transaction rather than left to collide.
 */
export async function setStyleReference(
  clientId: string,
  assetId: string,
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    await db().transaction(async (tx) => {
      await tx
        .update(brandAssets)
        .set({ isStyleReference: false })
        .where(
          and(
            eq(brandAssets.clientId, clientId),
            eq(brandAssets.isStyleReference, true),
          ),
        );

      await tx
        .update(brandAssets)
        .set({ isStyleReference: true })
        .where(eq(brandAssets.id, assetId));
    });

    revalidatePath(`/clients/${clientId}`);
  });
}

export async function clearStyleReference(
  clientId: string,
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();
    await db()
      .update(brandAssets)
      .set({ isStyleReference: false })
      .where(eq(brandAssets.clientId, clientId));
    revalidatePath(`/clients/${clientId}`);
  });
}

export async function deleteBrandAsset(
  assetId: string,
): Promise<ActionResult> {
  return guard(async () => {
    await requireUser();

    const [asset] = await db()
      .select()
      .from(brandAssets)
      .where(eq(brandAssets.id, assetId))
      .limit(1);
    if (!asset) return;

    await db().delete(brandAssets).where(eq(brandAssets.id, assetId));

    // The database row is the source of truth; a Blob left behind after a
    // failed delete is wasted storage, not a broken app.
    try {
      await del(asset.blobUrl, { token: env.blobToken });
    } catch {
      // ignore
    }

    revalidatePath(`/clients/${asset.clientId}`);
  });
}
