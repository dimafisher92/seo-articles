"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { startKeywordResearch } from "@/app/actions/keywords";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";

/**
 * Starts a keyword research + content gap run.
 *
 * Seeds and competitors are both optional: Claude derives seeds from the Brand
 * Vault, and competitors fall back to the vault list. The dialog exists so a
 * strategist can steer a run without editing the vault first.
 */
export function KeywordResearchLauncher({
  clientId,
  vaultCompetitors,
  hasExistingRun,
}: {
  clientId: string;
  vaultCompetitors: string[];
  hasExistingRun: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData): void {
    setError(null);
    const parseLines = (value: FormDataEntryValue | null): string[] =>
      String(value ?? "")
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean);

    startTransition(async () => {
      const result = await startKeywordResearch(clientId, {
        seeds: parseLines(formData.get("seeds")),
        competitors: parseLines(formData.get("competitors")),
        maxKeywords: Number(formData.get("maxKeywords") ?? 400),
      });

      if (result.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Sparkles />
          {hasExistingRun ? "New research run" : "Run keyword research"}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyword research &amp; content gap</DialogTitle>
          <DialogDescription>
            Pulls volume and difficulty, compares the client&apos;s rankings
            against competitors&apos;, and clusters everything by topic and
            intent. Takes a few minutes.
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <Field
            label="Extra seeds"
            hint="Optional — one per line. Claude derives its own from the Brand Vault as well."
          >
            <Textarea name="seeds" rows={3} placeholder={"industrial fasteners\nbolt torque chart"} />
          </Field>

          <Field
            label="Competitors"
            hint={
              vaultCompetitors.length > 0
                ? `Leave blank to use the vault list: ${vaultCompetitors.join(", ")}`
                : "One domain per line. Without competitors there is no content gap to find."
            }
          >
            <Textarea
              name="competitors"
              rows={3}
              placeholder="competitor.com"
              defaultValue=""
            />
          </Field>

          <Field
            label="Keyword cap"
            hint="How many keywords to keep. Higher means a longer run and a longer table to review."
          >
            <Input
              name="maxKeywords"
              type="number"
              min={20}
              max={2000}
              defaultValue={400}
            />
          </Field>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          {hasExistingRun ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              This starts a fresh run. The previous run&apos;s keywords and any
              plan built from them stay where they are.
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : <Sparkles />}
              Start research
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
