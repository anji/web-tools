import type { Section } from '@tools/core';
import { jsonTools } from '@tools/json';
import { jwtTools } from '@tools/jwt';
import { csvTools } from '@tools/csv';
import { lockfileTools } from '@tools/lockfile';
import { timeTools } from '@tools/time';
import { hashTools } from '@tools/hash';
import { llmTools } from '@tools/llm';

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
    tagline: 'Convert to JSON, SQL or typed structs, and profile what is in the file.',
    description:
      'Browser-based CSV tools: convert to JSON with real types, generate SQL schemas and inserts, produce typed structs for eight languages, and profile columns for nulls, ranges and malformed rows.',
    intro:
      'The files people most need to convert are the ones they least want to upload — an export of your customer table is not something to hand to a free web converter. Everything here parses in your tab, including the awkward parts: quoted delimiters, newlines inside fields, BOMs, semicolon exports and rows with the wrong field count.',
    tools: csvTools,
  },
  {
    slug: 'dependencies',
    name: 'Dependencies',
    tagline: 'Read a lockfile diff the way a reviewer needs to.',
    description:
      'Compare two lockfiles and see what actually changed: packages added, removed and upgraded by semver impact, plus integrity and registry changes worth questioning. npm, pnpm and yarn.',
    intro:
      'A lockfile is a map of everything your build trusts, and a private one names your internal registry — which is why these run in your tab rather than on someone else’s server. It is also thousands of lines nobody reads, which is how a change that matters gets merged unnoticed.',
    tools: lockfileTools,
  },
  {
    slug: 'llm',
    name: 'LLM & agents',
    tagline: 'Build and debug tool definitions and streamed responses.',
    description:
      'Generate an Anthropic tool definition from sample arguments, lint one against the constraints the API enforces, and reconstruct a message from a captured SSE stream. Nothing uploaded.',
    intro:
      'Deterministic tools for people building with models, rather than tools that call one. The things you would paste into a hosted helper here — a system prompt, a captured response, a tool schema naming your internal endpoints — are exactly the things that should not leave your machine, and none of this needs a model to be exact.',
    tools: llmTools,
  },
  {
    slug: 'time',
    name: 'Time & scheduling',
    tagline: 'Epoch conversion and cron, with daylight saving taken seriously.',
    description:
      'Convert Unix timestamps across time zones and preview exactly when a cron expression fires, including the local times that daylight saving skips or repeats.',
    intro:
      'Time arithmetic is where confident answers go wrong. A local time that occurs twice, or not at all, is not an edge case twice a year — it is a job that ran twice, or never, and a week of blaming the infrastructure.',
    tools: timeTools,
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
    name: 'Hashing & crypto',
    tagline: 'Digests and signatures, computed where the secret already is.',
    description:
      'Compute SHA-256, SHA-1, MD5 and CRC-32 digests, verify a published checksum, and generate an HMAC — all in your browser, with neither the input nor the key transmitted.',
    intro:
      'People hash the things they are most careful with: tokens, payloads, signing secrets. Every online hash generator that computes server-side receives the plaintext before it returns a digest, which rather defeats the exercise.',
    tools: hashTools,
  },
  {
    slug: 'jwt',
    name: 'JWT & tokens',
    tagline: 'Decode tokens, check their claims, and verify signatures locally.',
    description:
      'Decode a JWT, inspect its claims and expiry, check it for security problems, and verify an HS256 signature — all in your browser, with neither the token nor the signing secret leaving the tab.',
    intro:
      'A JWT you are debugging is, by definition, a working credential — and its signing secret is the key to minting more. Where you paste those is a security decision, not a convenience one, which is why all three tools here run as pure functions in your tab on a page the browser forbids from opening a network connection.',
    tools: jwtTools,
  },
];
