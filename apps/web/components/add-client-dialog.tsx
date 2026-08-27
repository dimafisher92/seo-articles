"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createClient } from "@/app/actions/clients";
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

export function AddClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData): void {
    setError(null);
    startTransition(async () => {
      const result = await createClient({
        name: String(formData.get("name") ?? ""),
        domain: String(formData.get("domain") ?? ""),
        country: String(formData.get("country") ?? "US"),
        locale: String(formData.get("locale") ?? "en-US"),
      });

      if (result.ok) {
        setOpen(false);
        router.push(`/clients/${result.data.id}`);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Add client
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a client</DialogTitle>
          <DialogDescription>
            The website is used for the site crawl, ranking data and internal
            links, so set it if you have it.
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <Field label="Client name">
            <Input name="name" required placeholder="Acme Supply Co" />
          </Field>

          <Field label="Website" hint="Scheme and path are stripped.">
            <Input name="domain" placeholder="acmesupply.com" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Market" hint="Two-letter country code.">
              <Input name="country" defaultValue="US" maxLength={2} />
            </Field>
            <Field label="Language" hint="Articles are written in this locale.">
              <Input name="locale" defaultValue="en-US" />
            </Field>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : null}
              Create client
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
