import type { AuthorPersona, FaqEntry } from "../types.js";

/**
 * Builds the structured-data blocks every article ships with.
 *
 * Only markup that describes what is actually on the page: the FAQPage block is
 * omitted when there are no questions, because marking up an FAQ that is not
 * rendered is a manual-action risk rather than a ranking trick.
 */

export type JsonLdInput = {
  title: string;
  description: string;
  slug: string;
  domain: string | null;
  author?: AuthorPersona | undefined;
  faq: FaqEntry[];
  imageUrl?: string;
  publisherName: string;
  datePublished?: string;
  dateModified?: string;
};

function articleUrl(domain: string | null, slug: string): string | null {
  if (!domain) return null;
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/blog/${slug}`;
}

export function buildJsonLd(input: JsonLdInput): unknown[] {
  const url = articleUrl(input.domain, input.slug);
  const published = input.datePublished ?? new Date().toISOString();
  const blocks: unknown[] = [];

  const author = input.author?.name
    ? {
        "@type": "Person",
        name: input.author.name,
        ...(input.author.title ? { jobTitle: input.author.title } : {}),
        ...(input.author.bio ? { description: input.author.bio } : {}),
      }
    : { "@type": "Organization", name: input.publisherName };

  blocks.push({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title.slice(0, 110),
    description: input.description,
    ...(url ? { mainEntityOfPage: { "@type": "WebPage", "@id": url }, url } : {}),
    ...(input.imageUrl ? { image: [input.imageUrl] } : {}),
    author,
    publisher: { "@type": "Organization", name: input.publisherName },
    datePublished: published,
    dateModified: input.dateModified ?? published,
  });

  if (input.faq.length > 0) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: input.faq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    });
  }

  if (url && input.domain) {
    const origin = `https://${input.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
    blocks.push({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: origin },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${origin}/blog` },
        { "@type": "ListItem", position: 3, name: input.title, item: url },
      ],
    });
  }

  return blocks;
}
