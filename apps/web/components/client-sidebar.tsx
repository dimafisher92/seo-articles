"use client";

import {
  BookOpen,
  Brain,
  ChevronLeft,
  FileText,
  Mountain,
  PenLine,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Per-client tool rail.
 *
 * The order mirrors the workflow the product enforces — knowledge first,
 * research second, plan third, articles last — so the sidebar doubles as a
 * reminder of which step comes next.
 */
const TOOLS = [
  {
    href: "",
    label: "Knowledge Base",
    icon: Brain,
    hint: "Brand, audience, assets",
  },
  {
    href: "/keywords",
    label: "Keyword Research",
    icon: Mountain,
    hint: "Volume, difficulty, content gap",
  },
  {
    href: "/plan",
    label: "Content Plan",
    icon: BookOpen,
    hint: "Titles and briefs",
  },
  {
    href: "/articles",
    label: "Articles",
    icon: FileText,
    hint: "Drafts and exports",
  },
] as const;

export function ClientSidebar({
  clientId,
  clientName,
  domain,
}: {
  clientId: string;
  clientName: string;
  domain: string | null;
}) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;

  return (
    <aside className="sticky top-0 flex h-screen w-[260px] shrink-0 flex-col border-r border-border bg-gradient-to-b from-accent/40 to-background">
      <div className="border-b border-border/60 p-4">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3" />
          All clients
        </Link>
        <p className="truncate font-semibold leading-tight">{clientName}</p>
        {domain ? (
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-primary"
          >
            {domain}
          </a>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">
            no website set
          </p>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-3">
        <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Client tools
        </p>

        {TOOLS.map((tool) => {
          const href = `${base}${tool.href}`;
          // The Knowledge Base sits at the bare client route, so it can only
          // match exactly — otherwise it would light up on every sub-page.
          const active = tool.href
            ? pathname.startsWith(href)
            : pathname === base;
          const Icon = tool.icon;

          return (
            <Link
              key={tool.label}
              href={href}
              className={cn(
                "flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "hover:bg-accent",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  active ? "" : "text-primary",
                )}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {tool.label}
                </span>
                <span
                  className={cn(
                    "block truncate text-[11px]",
                    active
                      ? "text-primary-foreground/75"
                      : "text-muted-foreground",
                  )}
                >
                  {tool.hint}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border/60 p-3">
        <p className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
          <PenLine className="size-3" />
          Research first, then plan, then write.
        </p>
      </div>
    </aside>
  );
}
