import { notFound, redirect } from "next/navigation";

import { getClient } from "@/app/actions/clients";
import { ClientSidebar } from "@/components/client-sidebar";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  if (!(await currentUser())) redirect("/signin");

  const { id } = await params;
  const client = await getClient(id);
  if (!client) notFound();

  return (
    <div className="flex min-h-screen">
      <ClientSidebar
        clientId={client.id}
        clientName={client.name}
        domain={client.domain}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
