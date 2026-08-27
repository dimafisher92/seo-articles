"use client";

import { Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { crawlClientSite } from "@/app/actions/clients";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";

/** Queues the crawl that autofills empty Brand Vault fields from the site. */
export function CrawlSiteButton({
  clientId,
  hasDomain,
}: {
  clientId: string;
  hasDomain: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        disabled={pending || !hasDomain}
        title={hasDomain ? undefined : "Set the client's website first"}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await crawlClientSite(clientId);
            if (result.ok) router.refresh();
            else setError(result.error);
          })
        }
      >
        {pending ? <Spinner /> : <Globe />}
        Fill from website
      </Button>
      {error ? (
        <p className="max-w-xs text-right text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
