import type { Section } from '@tools/core';
import { jsonTools } from '@tools/json';

/**
 * The site is a set of sections. A section with tools is ours; a section
 * without them is a placeholder that points at whoever does it best today and
 * gets replaced, in place and at the same URL, when we build it.
 *
 * The `local` flag on each recommendation is researched, not assumed. Marking
 * something local that quietly uploads would cost more trust than the extra
 * listing is worth, so anything uncertain is marked false.
 */
export const sections: readonly Section[] = [
  {
    slug: 'json',
    name: 'JSON',
    tagline: 'Format, convert, diff and de-secret JSON.',
    description:
      'Twelve JSON tools that run in your browser: formatter, TypeScript and Zod generators, diff, JSONPath, CSV and YAML conversion, and a secret scanner. No upload, no sign-up.',
    intro:
      'Everything here runs as a pure function inside your tab. That is what makes it safe to paste a real API response — the kind with customer emails, internal hostnames and a live bearer token in it.',
    tools: jsonTools,
  },
  {
    slug: 'csv',
    name: 'CSV & spreadsheets',
    tagline: 'Convert, clean and inspect tabular data.',
    description:
      'Browser-based CSV tools: convert to JSON and SQL, deduplicate, detect column types, compare files and anonymise columns. In development.',
    intro:
      'This is the section we are building next, for the same reason JSON came first: the files people most need to convert are the ones they least want to upload. An export of your customer table is not something to hand to a free web converter.',
    tools: [],
    recommendations: [],
  },
  {
    slug: 'regex',
    name: 'Regex',
    tagline: 'Build, test and understand regular expressions.',
    description:
      'Regular expression testers and explainers, with notes on which ones evaluate your pattern in the browser and which send it to a server.',
    intro:
      'Regex is lower stakes than a credentials-bearing payload, but the test strings people paste are often real data. Where a tester evaluates matters more than people assume.',
    tools: [],
    recommendations: [
      {
        name: 'RegExr',
        href: 'https://regexr.com/',
        blurb: 'Live tester with an inline explanation of every token in your pattern.',
        local: true,
      },
      {
        name: 'regex101',
        href: 'https://regex101.com/',
        blurb: 'The most thorough tester, with a step-by-step debugger and multiple flavours.',
        local: false,
      },
    ],
  },
  {
    slug: 'pdf',
    name: 'PDF',
    tagline: 'Merge, split, compress and edit PDFs.',
    description:
      'Browser-based PDF tools that do not upload your documents. Curated until we build our own.',
    intro:
      'PDFs are the format people most often need to edit and least often should upload — contracts, payslips, scans of identity documents. Good local options already exist here, so this section points at them rather than pretending otherwise.',
    tools: [],
    recommendations: [
      {
        name: 'iHatePDF',
        href: 'https://www.ihatepdf.cv/',
        blurb: 'Around 46 PDF tools running on WebAssembly in the browser. No watermark, no sign-up.',
        local: true,
      },
      {
        name: 'Stirling PDF',
        href: 'https://github.com/Stirling-Tools/Stirling-PDF',
        blurb: 'Open source and self-hosted. The right answer when the documents cannot leave your network at all.',
        local: false,
        label: 'self-hosted',
      },
    ],
  },
  {
    slug: 'images',
    name: 'Images',
    tagline: 'Compress, convert and strip metadata.',
    description:
      'Image compression and conversion that happens on your device, plus metadata stripping. Curated until we build our own.',
    intro:
      'Photographs carry more than they look like they do — GPS coordinates, device serial numbers and timestamps all ride along in EXIF. Processing locally is the only way to strip that without handing over the original first.',
    tools: [],
    recommendations: [
      {
        name: 'Squoosh',
        href: 'https://squoosh.app/',
        blurb: 'Compression and format conversion with a side-by-side quality comparison. Built by the Chrome team.',
        local: true,
      },
    ],
  },
  {
    slug: 'encoding',
    name: 'Encoding & crypto',
    tagline: 'Base64, hashes, ciphers and data mangling.',
    description:
      'Encoding, decoding, hashing and data transformation tools that run locally.',
    intro:
      'The things people base64-decode are usually the things they should be most careful with: tokens, certificates, config blobs, the payload half of a JWT.',
    tools: [],
    recommendations: [
      {
        name: 'CyberChef',
        href: 'https://gchq.github.io/CyberChef/',
        blurb: 'The "cyber swiss army knife" — chain hundreds of encoding, crypto and analysis operations. Entirely client-side.',
        local: true,
      },
    ],
  },
  {
    slug: 'jwt',
    name: 'JWT & tokens',
    tagline: 'Decode and inspect tokens and certificates.',
    description:
      'Decode JWTs, inspect claims and expiry, and check certificates without pasting them into a server.',
    intro:
      'A JWT you are debugging is, by definition, a working credential. Where you paste it is a security decision, not a convenience one.',
    tools: [],
    recommendations: [
      {
        name: 'jwt.io',
        href: 'https://jwt.io/',
        blurb: 'The standard JWT debugger. Decoding happens in the browser.',
        local: true,
      },
    ],
  },
];
