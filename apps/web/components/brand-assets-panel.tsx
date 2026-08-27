"use client";

import { upload } from "@vercel/blob/client";
import { ImagePlus, Palette, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import type { BrandAsset } from "@seo/db";

import {
  clearStyleReference,
  deleteBrandAsset,
  registerBrandAsset,
  setStyleReference,
  updateBrandAsset,
} from "@/app/actions/brand-vault";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

const CATEGORIES = ["product", "lifestyle", "team", "diagram", "logo", "other"];

/**
 * Brand image library.
 *
 * Two jobs: supply real photography articles can use instead of generated
 * imagery, and nominate one asset as the style reference Magnific matches, so
 * generated images inherit the brand's look rather than defaulting to stock.
 */
export function BrandAssetsPanel({
  clientId,
  assets,
}: {
  clientId: string;
  assets: BrandAsset[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(files.length);

    try {
      for (const file of Array.from(files)) {
        // Straight to Blob from the browser — a serverless round trip would
        // cap this at 4.5 MB, which product photography clears easily.
        const blob = await upload(`brand-assets/${clientId}/${file.name}`, file, {
          access: "public",
          handleUploadUrl: "/api/upload",
        });

        await registerBrandAsset(clientId, {
          blobUrl: blob.url,
          pathname: blob.pathname,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(0);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const styleReference = assets.find((a) => a.isStyleReference);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Brand images</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Used directly in articles, and as the style reference for generated
            imagery.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => fileInput.current?.click()}
          disabled={uploading > 0}
        >
          {uploading > 0 ? <Spinner /> : <ImagePlus />}
          {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div
          className={cn(
            "flex items-start gap-3 rounded-lg border p-3 text-sm",
            styleReference
              ? "border-primary/30 bg-primary/5"
              : "border-dashed border-border",
          )}
        >
          <Palette className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            {styleReference ? (
              <>
                <p className="font-medium">
                  Style reference: {styleReference.filename ?? "selected image"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Generated images will match its palette, lighting and
                  treatment.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">No style reference set</p>
                <p className="text-xs text-muted-foreground">
                  Pick the image that best represents the brand&apos;s visual
                  style. Without one, generated images look like generic stock.
                </p>
              </>
            )}
          </div>
          {styleReference ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                startTransition(async () => {
                  await clearStyleReference(clientId);
                  router.refresh();
                })
              }
            >
              <X />
              Clear
            </Button>
          ) : null}
        </div>

        {assets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No images yet. Upload the client&apos;s product shots and brand
            photography.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                clientId={clientId}
                asset={asset}
                onChanged={() => router.refresh()}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AssetCard({
  clientId,
  asset,
  onChanged,
}: {
  clientId: string;
  asset: BrandAsset;
  onChanged: () => void;
}) {
  const [altText, setAltText] = useState(asset.altText ?? "");
  const [category, setCategory] = useState(asset.category ?? "");
  const [, startTransition] = useTransition();

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative aspect-[4/3] bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.blobUrl}
          alt={asset.altText ?? asset.filename ?? "Brand asset"}
          className="size-full object-cover"
          loading="lazy"
        />
        {asset.isStyleReference ? (
          <Badge className="absolute left-2 top-2 bg-primary text-primary-foreground">
            <Palette className="size-3" />
            Style reference
          </Badge>
        ) : null}
      </div>

      <div className="space-y-2 p-3">
        <Input
          className="h-8 text-xs"
          value={altText}
          placeholder="Describe this image"
          onChange={(e) => setAltText(e.target.value)}
          onBlur={() =>
            startTransition(async () => {
              await updateBrandAsset(asset.id, { altText, category });
            })
          }
        />

        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            startTransition(async () => {
              await updateBrandAsset(asset.id, {
                altText,
                category: e.target.value,
              });
              onChanged();
            });
          }}
          className="h-8 w-full rounded-md border border-input bg-card px-2 text-xs"
        >
          <option value="">Uncategorised</option>
          {CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {!asset.isStyleReference ? (
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs"
              onClick={() =>
                startTransition(async () => {
                  await setStyleReference(clientId, asset.id);
                  onChanged();
                })
              }
            >
              <Palette />
              Use as style
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete image"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={() =>
              startTransition(async () => {
                await deleteBrandAsset(asset.id);
                onChanged();
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </li>
  );
}
