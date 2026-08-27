"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { syncNotion } from "@/app/actions/clients";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";

export function NotionSyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  function run(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await syncNotion();
      if (result.ok) {
        const { created, updated, skipped } = result.data;
        setIsError(false);
        setMessage(
          `${created} added, ${updated} updated` +
            (skipped.length ? `, ${skipped.length} skipped` : ""),
        );
        router.refresh();
      } else {
        setIsError(true);
        setMessage(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      {message ? (
        <span
          className={
            isError
              ? "max-w-xs truncate text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
          title={message}
        >
          {message}
        </span>
      ) : null}
      <Button variant="outline" onClick={run} disabled={pending}>
        {pending ? <Spinner /> : <RefreshCw />}
        Sync from Notion
      </Button>
    </div>
  );
}
