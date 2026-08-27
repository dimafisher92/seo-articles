"use client";

import { BookOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { startContentPlan } from "@/app/actions/keywords";
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
import { Field, Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";

/**
 * The separate content-plan step.
 *
 * Kept distinct from research on purpose: the strategist reviews the keyword
 * table and decides what deserves an article before any planning spend, and
 * the plan itself produces titles only — bodies are commissioned one at a time.
 */
export function BuildPlanButton({
  clientId,
  runId,
  selectedCount,
}: {
  clientId: string;
  runId: string;
  selectedCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const suggested = Math.max(1, Math.min(30, Math.round(selectedCount / 3)));

  function submit(formData: FormData): void {
    setError(null);
    startTransition(async () => {
      const result = await startContentPlan(clientId, {
        runId,
        targetTitles: Number(formData.get("targetTitles") ?? suggested),
      });

      if (result.ok) {
        setOpen(false);
        router.push(`/clients/${clientId}/plan`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={selectedCount === 0}>
          <BookOpen />
          Build content plan
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Build the content plan</DialogTitle>
          <DialogDescription>
            Groups the {selectedCount} selected keyword
            {selectedCount === 1 ? "" : "s"} into articles and writes a title and
            brief for each. No article bodies yet — you commission those one at a
            time.
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <Field
            label="How many articles"
            hint="One article usually owns a whole cluster of related keywords, so this is well below the keyword count."
          >
            <Input
              name="targetTitles"
              type="number"
              min={1}
              max={60}
              defaultValue={suggested}
            />
          </Field>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : <BookOpen />}
              Build plan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
