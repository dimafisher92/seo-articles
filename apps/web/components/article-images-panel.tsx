"use client";

import { AlertCircle, ImageIcon, RefreshCw, Replace } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { ArticleImage, BrandAsset } from "@seo/db";

import { regenerateImage, useBrandAssetForImage } from "@/app/actions/articles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";

/**
 * Image management for a drafted article.
 *
 * Each slot can be re-rendered from an edited prompt or swapped for a photo
 * from the Brand Vault. Swapping rewrites the body's image URL too, so the
 * Markdown, the preview and the export never disagree about what is on the page.
 */
export function ArticleImagesPanel({
  images,
  brandAssets,
}: {
  images: ArticleImage[];
  brandAssets: BrandAsset[];
}) {
  if (images.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        This article has no images yet.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {images.map((image) => (
        <ImageRow key={image.id} image={image} brandAssets={brandAssets} />
      ))}
    </ul>
  );
}

function ImageRow({
  image,
  brandAssets,
}: {
  image: ArticleImage;
  brandAssets: BrandAsset[];
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(image.prompt ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <li className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-[220px_1fr]">
      <div className="overflow-hidden rounded-lg border border-border bg-muted">
        {image.blobUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.blobUrl}
            alt={image.altText ?? ""}
            className="aspect-[3/2] w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex aspect-[3/2] items-center justify-center text-muted-foreground">
            {image.status === "generating" ? (
              <Spinner />
            ) : (
              <ImageIcon className="size-6" />
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={image.role === "hero" ? "default" : "secondary"}>
            {image.role}
          </Badge>
          <Badge variant="outline">{image.source.replace("_", " ")}</Badge>
          {image.status === "failed" ? (
            <Badge variant="destructive">
              <AlertCircle className="size-3" />
              failed
            </Badge>
          ) : null}
          {image.placementHeading ? (
            <span className="truncate text-xs text-muted-foreground">
              under &ldquo;{image.placementHeading}&rdquo;
            </span>
          ) : null}
        </div>

        {image.altText ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Alt: </span>
            {image.altText}
          </p>
        ) : (
          <p className="text-sm text-destructive">No alt text set</p>
        )}

        {image.error ? (
          <p className="text-xs text-destructive">{image.error}</p>
        ) : null}

        <div>
          <Label className="text-xs">Generation prompt</Label>
          <Textarea
            rows={3}
            className="mt-1 text-xs"
            value={prompt}
            placeholder="Describe the image to generate"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !prompt.trim()}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await regenerateImage(image.id, prompt.trim());
                if (result.ok) router.refresh();
                else setError(result.error);
              })
            }
          >
            {pending ? <Spinner /> : <RefreshCw />}
            Regenerate
          </Button>

          <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="ghost" disabled={brandAssets.length === 0}>
                <Replace />
                Use a brand photo
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Pick a brand image</DialogTitle>
              </DialogHeader>
              <ul className="grid max-h-[60vh] gap-3 overflow-y-auto sm:grid-cols-3">
                {brandAssets.map((asset) => (
                  <li key={asset.id}>
                    <button
                      className="w-full overflow-hidden rounded-lg border border-border transition-colors hover:border-primary"
                      onClick={() =>
                        startTransition(async () => {
                          const result = await useBrandAssetForImage(
                            image.id,
                            asset.id,
                            asset.blobUrl,
                          );
                          setPickerOpen(false);
                          if (result.ok) router.refresh();
                          else setError(result.error);
                        })
                      }
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={asset.blobUrl}
                        alt={asset.altText ?? asset.filename ?? ""}
                        className="aspect-[4/3] w-full object-cover"
                        loading="lazy"
                      />
                      <span className="block truncate px-2 py-1 text-left text-xs text-muted-foreground">
                        {asset.altText ?? asset.filename}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </DialogContent>
          </Dialog>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </li>
  );
}
