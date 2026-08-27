import { Building2, ExternalLink, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { listClients } from "@/app/actions/clients";
import { AddClientDialog } from "@/components/add-client-dialog";
import { NotionSyncButton } from "@/components/notion-sync-button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = {
  active: "success",
  paused: "warning",
  offboarded: "outline",
} as const;

export default async function ClientsPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");

  const clients = await listClients();

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a client to work on their keywords, plan and articles.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NotionSyncButton />
          <AddClientDialog />
        </div>
      </header>

      {clients.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-8" />}
          title="No clients yet"
          description="Pull the roster in from Notion, or add a client by hand to get started."
          action={<AddClientDialog />}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {clients.map((client) => (
            <li key={client.id}>
              <Card className="group transition-colors hover:border-primary/40">
                <Link
                  href={`/clients/${client.id}`}
                  className="flex items-start justify-between gap-4 p-5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium group-hover:text-primary">
                      {client.name}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-muted-foreground">
                      {client.domain ?? "no website set"}
                      {client.domain ? (
                        <ExternalLink className="size-3 shrink-0" />
                      ) : null}
                    </p>
                    {client.serviceType ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {client.serviceType}
                      </p>
                    ) : null}
                  </div>
                  <Badge variant={STATUS_VARIANT[client.status]}>
                    {client.status}
                  </Badge>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-10 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Plus className="size-3" />
        Signed in as {user.email}
      </p>
    </main>
  );
}
