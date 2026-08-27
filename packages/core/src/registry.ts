import type { ToolDefinition } from './tool.js';

export interface SiteBrand {
  /** Product name as shown in the header, e.g. "LocalUse". */
  name: string;
  /** Canonical origin, no trailing slash. */
  origin: string;
  tagline: string;
  /** Meta description for the site homepage. */
  description: string;
  /** Repo URL, surfaced in the footer. Open source is the distribution channel. */
  repo?: string;
}

/**
 * A tool we have not built yet but that someone else has, linked from the
 * section that will eventually replace it.
 *
 * `local` is recorded honestly, including when the answer is no. A directory
 * whose whole pitch is "nothing gets uploaded" loses more by quietly
 * recommending an uploader than it gains by padding the list.
 */
export interface ExternalTool {
  name: string;
  href: string;
  blurb: string;
  /** True only where the tool is known to process in the browser. */
  local: boolean;
  /**
   * Overrides the badge text. "Sends to a server" is true but misleading for a
   * self-hosted tool, where the server is the reader's own.
   */
  label?: string;
}

export interface Section {
  /** URL segment: /json/, /images/ ... */
  slug: string;
  /** Display name, e.g. "JSON". */
  name: string;
  /** One line for the section card. */
  tagline: string;
  /** Meta description for the section landing page. */
  description: string;
  /** Intro paragraph under the section H1. */
  intro: string;
  /** Our own tools. Empty until the section is built. */
  tools: readonly ToolDefinition<any>[];
  /** Shown while the section has no tools of its own. */
  recommendations?: readonly ExternalTool[];
}

export interface SiteRegistry {
  brand: SiteBrand;
  sections: readonly Section[];
  /** Sections that ship tools of their own. */
  live(): readonly Section[];
  /** Sections that only carry recommendations so far. */
  planned(): readonly Section[];
  section(slug: string): Section | undefined;
  /** Every tool across every section, for the worker's id lookup. */
  allTools(): readonly ToolDefinition<any>[];
  sectionPath(section: Section): string;
  toolPath(section: Section, tool: ToolDefinition<any>): string;
  /** Every indexable URL, for sitemap.xml. */
  urls(): readonly string[];
}

export function createRegistry(brand: SiteBrand, sections: readonly Section[]): SiteRegistry {
  const seenSections = new Set<string>();
  for (const section of sections) {
    if (seenSections.has(section.slug)) throw new Error(`Duplicate section slug: ${section.slug}`);
    seenSections.add(section.slug);

    // Tool slugs only have to be unique within their section, since the section
    // is part of the path -- but a collision there would silently drop a page.
    const seenTools = new Set<string>();
    for (const tool of section.tools) {
      if (seenTools.has(tool.slug)) {
        throw new Error(`Duplicate tool slug "${tool.slug}" in section "${section.slug}"`);
      }
      seenTools.add(tool.slug);
    }
  }

  const sectionPath = (section: Section) => `/${section.slug}/`;
  const toolPath = (section: Section, tool: ToolDefinition<any>) =>
    `/${section.slug}/${tool.slug}/`;

  const live = () => sections.filter((s) => s.tools.length > 0);
  const planned = () => sections.filter((s) => s.tools.length === 0);

  return {
    brand,
    sections,
    live,
    planned,
    section: (slug) => sections.find((s) => s.slug === slug),
    allTools: () => sections.flatMap((s) => s.tools),
    sectionPath,
    toolPath,
    urls: () => [
      `${brand.origin}/`,
      // Planned sections are indexable too: a page that honestly says "not built
      // yet, here is what we use meanwhile" is a real page with real content.
      ...sections.map((s) => brand.origin + sectionPath(s)),
      ...sections.flatMap((s) => s.tools.map((t) => brand.origin + toolPath(s, t))),
    ],
  };
}
