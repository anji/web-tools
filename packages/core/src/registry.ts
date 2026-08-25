import type { ToolDefinition } from './tool.js';

export interface SiteBrand {
  /** Product name as shown in the header, e.g. "iHateJSON". */
  name: string;
  /** Canonical origin, no trailing slash, e.g. "https://ihatejson.com". */
  origin: string;
  tagline: string;
  /** Meta description for the site homepage. */
  description: string;
  /** Tailwind-compatible accent hue used across the site. */
  accent: string;
  /** Repo URL, surfaced in the footer. Open source is the distribution channel. */
  repo?: string;
  /** Sibling sites rendered in the footer -- the cross-link network. */
  siblings?: ReadonlyArray<{ name: string; href: string; blurb: string }>;
}

export interface ToolRegistry {
  brand: SiteBrand;
  tools: readonly ToolDefinition<any>[];
  bySlug(slug: string): ToolDefinition<any> | undefined;
  categories(): ReadonlyArray<{ name: string; tools: readonly ToolDefinition<any>[] }>;
  /** Every indexable URL on the site, for sitemap.xml. */
  urls(): readonly string[];
}

export function createRegistry(
  brand: SiteBrand,
  tools: readonly ToolDefinition<any>[],
): ToolRegistry {
  const slugs = new Set<string>();
  for (const t of tools) {
    if (slugs.has(t.slug)) throw new Error(`Duplicate tool slug: ${t.slug}`);
    slugs.add(t.slug);
  }

  return {
    brand,
    tools,
    bySlug: (slug) => tools.find((t) => t.slug === slug),
    categories() {
      const order: string[] = [];
      const grouped = new Map<string, ToolDefinition<any>[]>();
      for (const t of tools) {
        let bucket = grouped.get(t.category);
        if (!bucket) {
          bucket = [];
          grouped.set(t.category, bucket);
          order.push(t.category);
        }
        bucket.push(t);
      }
      return order.map((name) => ({ name, tools: grouped.get(name)! }));
    },
    urls: () => [brand.origin + '/', ...tools.map((t) => `${brand.origin}/${t.slug}/`)],
  };
}
