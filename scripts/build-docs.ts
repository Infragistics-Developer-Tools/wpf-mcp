#!/usr/bin/env tsx
/**
 * build-docs.ts
 *
 * Processes .adoc files from the docs submodules and produces:
 *   src/data/docs-index.json       lightweight search index (loaded at startup)
 *   src/data/docs/{slug}.json      full topic content     (loaded on demand)
 *
 * Sources:
 *   docs/docs-wpf/topics/en/*.adoc                  — all 1 800+ WPF topics
 *   docs/docs-common/topics/en/{folder}/*.adoc       — WPF-relevant shared topics
 *
 * Run:  npx tsx scripts/build-docs.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSubmodules } from './ensure-submodules.js';
import { assertBuildStep } from './build-guard.js';

ensureSubmodules();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT            = join(__dirname, '..');
const DOCS_WPF_DIR    = join(ROOT, 'docs', 'docs-wpf',    'topics', 'en');
const DOCS_COMMON_DIR = join(ROOT, 'docs', 'docs-common', 'topics', 'en');
const DOCS_CONFIG_FILE = join(ROOT, 'docs', 'docs-common', 'DocsConfig.xml');
const OUT_DIR         = join(ROOT, 'src', 'data', 'docs');
const INDEX_FILE      = join(ROOT, 'src', 'data', 'docs-index.json');

// WPF-relevant subfolders from docs-common.
// Excluded: data-grid (web / Blazor grid — WPF's XamDataGrid is in docs-wpf)
const COMMON_INCLUDE = new Set([
  'barcodes', 'bullet-graph', 'category-chart', 'data-chart', 'data-pie-chart',
  'document-engine', 'donut-chart', 'excel-engine', 'financial-chart', 'funnel-chart',
  'geographic-map', 'linear-gauge', 'pie-chart', 'productivity-tools', 'radial-gauge',
  'scheduler', 'shape-chart', 'sparkline', 'spreadsheet', 'surface-chart', 'win-web-chart',
]);

// ── DocsConfig variable substitution (WPF product) ────────────────────────────
//
// docs-common topics are shared across every Infragistics platform, so they
// reference controls via placeholders like {CategoryChartName} instead of a
// hardcoded name — the actual per-product values live in DocsConfig.xml as
// <Variable Name="..." Products="..." Value="..."/> entries (768 of them,
// covering every shared control/chart family, not just one component).
// We resolve the "wpf" product's table once, generically, so every topic's
// controlName/title/body gets the real control name (e.g. "XamCategoryChart")
// instead of the raw placeholder or an empty string.

function loadWpfVariables(): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(DOCS_CONFIG_FILE)) {
    // If docs-common is already on disk, the missing config is a real problem:
    // every shared topic placeholder ({DataGridName}, {CategoryChartName}, …) would
    // be stripped to an empty string and search_wpf_docs would return zero results
    // for all those controls. Fail loudly so the broken index is never committed.
    if (existsSync(DOCS_COMMON_DIR)) {
      throw new Error(
        `\n❌  DocsConfig.xml not found at:\n    ${DOCS_CONFIG_FILE}\n\n` +
        `docs/docs-common is present, but without DocsConfig.xml every shared topic\n` +
        `placeholder (e.g. {DataGridName}) resolves to an empty string, so\n` +
        `search_wpf_docs returns zero results for most controls.\n\n` +
        `Fix: ensure the submodule was initialised and is at a commit that includes\n` +
        `DocsConfig.xml:\n` +
        `    git submodule update --init --recursive\n`
      );
    }
    return vars; // docs-common not present either — discoverFiles() will warn separately
  }

  const xml = readFileSync(DOCS_CONFIG_FILE, 'utf-8');
  const tagRe = /<Variable\s+([^>]*?)\/>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((attrMatch = attrRe.exec(tagMatch[1])) !== null) attrs[attrMatch[1]] = attrMatch[2];
    const { Name: name, Products: productsRaw, Value: value } = attrs;
    if (!name || value === undefined) continue;

    const products = (productsRaw ?? '').split(',').map(p => p.trim());
    const isWpf = products.includes('wpf');
    const isAll = products.includes('all');
    if (!isWpf && !isAll) continue;
    // A wpf-specific entry always wins over a generic "all" fallback for the same name.
    if (isWpf || !vars.has(name)) vars.set(name, value);
  }

  // Resolve nested {Var} references, e.g. CategoryChartName -> "{ControlPrefix}CategoryChart" -> "XamCategoryChart".
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [name, value] of vars) {
      const resolved = value.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, ref) => vars.get(ref) ?? whole);
      if (resolved !== value) { vars.set(name, resolved); changed = true; }
    }
    if (!changed) break;
  }
  return vars;
}

const WPF_VARS = loadWpfVariables();

/** Replace {VarName} placeholders using the resolved WPF variable table; unresolved ones are dropped. */
function resolveVars(text: string): string {
  return text.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, name) => WPF_VARS.get(name) ?? '');
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdocMetadata {
  name: string;
  controlName?: string[];
  tags?: string[];
}

export interface DocIndexEntry {
  slug:         string;    // e.g. "xamdockmanager-add-content-to-a-contentpane"
  title:        string;    // e.g. "Add Content to a ContentPane"
  controlNames: string[];  // e.g. ["xamDockManager"]
  tags:         string[];  // e.g. ["How Do I", "Getting Started"]
  source:       'wpf' | 'common';
  summary:      string;    // first ~220 chars of plain body text
}

export interface DocEntry extends DocIndexEntry {
  body:         string;    // full stripped body (code blocks as plain text)
  xamlSnippets: string[];  // extracted XAML-only code blocks
}

// ── AsciiDoc helpers ──────────────────────────────────────────────────────────

/** Extract the JSON metadata block: |metadata| { ... } |metadata| */
function parseMetadata(raw: string): AdocMetadata | null {
  const m = raw.match(/\|metadata\|([\s\S]*?)\|metadata\|/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim()) as AdocMetadata;
  } catch {
    return null;
  }
}

/**
 * Extract the document title (first `= Heading` line outside the metadata comment block).
 * Strips the //// comment wrapper first so = chars inside JSON are ignored.
 */
function extractTitle(raw: string): string {
  // Remove //// comment blocks so we don't match = inside JSON
  const withoutComments = raw.replace(/\/\/\/\/[\s\S]*?\/\/\/\//g, '');
  for (const line of withoutComments.split('\n')) {
    const m = line.match(/^= (.+)/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Extract XAML-only code blocks.
 *
 * docs-wpf marker:    *In XAML:*  (or *In XAML*:)  followed by ---- fence
 * docs-common marker: [source, xaml]  (or [source,xaml])  followed by ---- fence
 */
function extractXamlSnippets(raw: string): string[] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const snippets: string[] = [];

  // Two capture patterns — both look for their marker immediately before a ---- block
  // (with optional blank lines in between).
  const PATTERNS = [
    // docs-wpf: *In XAML:*  or  *In XAML*:
    /\*In XAML\*?:\*?\s*\n+----\n([\s\S]*?)(?=\n----)/gi,
    // docs-common: [source, xaml]  /  [source,xaml]
    /\[source\s*,\s*xaml\]\s*\n----\n([\s\S]*?)(?=\n----)/gi,
  ];

  for (const re of PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const snippet = m[1].trim();
      if (snippet.length > 0) snippets.push(snippet);
    }
  }

  return snippets;
}

/**
 * Strip AsciiDoc markup and return plain searchable text.
 * Code block content is kept as plain text (no fences).
 */
function stripAdoc(raw: string): string {
  return raw
    // ── Remove structural blocks we don't want ───────────────────────────────
    // //// comment blocks (metadata lives here)
    .replace(/\/\/\/\/[\s\S]*?\/\/\/\//g, '')
    // ifdef / ifndef / ifeval / endif directives (whole line)
    .replace(/^(?:ifdef|ifndef|ifeval)::[^\[]*\[[^\]]*\]\s*$/gm, '')
    .replace(/^endif::[^\[]*\[\]\s*$/gm, '')
    // Single-line // comments
    .replace(/^\/\/ .+$/gm, '')
    // image:: macros
    .replace(/image::[^\[]*\[[^\]]*\]/g, '')
    // include:: directives
    .replace(/^include::.+$/gm, '')

    // ── Strip inline markup, keep visible text ───────────────────────────────
    // link:url[text] / xref:url[text] / link:{var}url[text] → text
    .replace(/(?:link|xref):[^\[]*\[([^\]]*)\]/g, '$1')
    // {AttributeReference} → empty (template vars like {DataChartName})
    .replace(/\{[A-Za-z0-9_.-]+\}/g, '')
    // *bold* → bold, _italic_ → italic (keep text)
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    // `monospace` → text
    .replace(/`([^`\n]+)`/g, '$1')

    // ── Remove formatting-only markers ───────────────────────────────────────
    // Block type annotations: [source, xaml], [NOTE], [TIP], etc.
    .replace(/^\[[^\]]+\]\s*$/gm, '')
    // AsciiDoc heading markers (= / == / === …) — keep heading text
    .replace(/^={1,6} /gm, '')
    // Table delimiters
    .replace(/^\|====.*$/gm, '')
    .replace(/^\|[-]+.*$/gm, '')
    // Code fence delimiters (---- and ....) — keep code content
    .replace(/^(?:----|\.\.\.\.)$/gm, '')
    // Horizontal rules '''
    .replace(/^'{3,}$/gm, '')
    // List continuation +
    .replace(/^\+$/gm, '')

    // ── Normalise whitespace ─────────────────────────────────────────────────
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── File processor ────────────────────────────────────────────────────────────

function processFile(filePath: string, source: 'wpf' | 'common'): DocEntry | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Resolve {PlaceholderName} tokens (shared docs-common topics) into real WPF
  // control names before any parsing, so metadata/title/body all see the
  // resolved text (e.g. "XamCategoryChart" instead of "{CategoryChartName}").
  raw = resolveVars(raw);

  const meta = parseMetadata(raw);
  if (!meta?.name) return null;

  const slug         = meta.name.trim();
  const title        = extractTitle(raw);
  const controlNames = (meta.controlName ?? []).map(s => s.trim()).filter(Boolean);
  const tags         = (meta.tags ?? []).map(s => s.trim()).filter(Boolean);
  const xamlSnippets = extractXamlSnippets(raw);
  const body         = stripAdoc(raw);

  // Summary: first ~220 printable chars of body
  const summary = body.replace(/\s+/g, ' ').slice(0, 220).trim();

  if (!title && !summary) return null; // skip empty/broken files

  return { slug, title, controlNames, tags, source, summary, body, xamlSnippets };
}

// ── File discovery ────────────────────────────────────────────────────────────

/** Recursively collect .adoc files under a directory. */
function collectAdoc(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...collectAdoc(fullPath));
    } else if (entry.endsWith('.adoc')) {
      results.push(fullPath);
    }
  }
  return results;
}

interface FileSource { path: string; source: 'wpf' | 'common' }

function discoverFiles(): FileSource[] {
  const files: FileSource[] = [];

  if (existsSync(DOCS_WPF_DIR)) {
    // docs-wpf: all .adoc directly in topics/en/ (flat folder)
    for (const f of readdirSync(DOCS_WPF_DIR)) {
      const fullPath = join(DOCS_WPF_DIR, f);
      if (f.endsWith('.adoc') && statSync(fullPath).isFile()) {
        files.push({ path: fullPath, source: 'wpf' });
      }
    }
  } else {
    console.warn('⚠  docs/docs-wpf not found. Run: git submodule update --init --recursive');
  }

  if (existsSync(DOCS_COMMON_DIR)) {
    for (const folder of readdirSync(DOCS_COMMON_DIR)) {
      if (!COMMON_INCLUDE.has(folder)) continue;
      const folderPath = join(DOCS_COMMON_DIR, folder);
      if (!statSync(folderPath).isDirectory()) continue;
      for (const f of collectAdoc(folderPath)) {
        files.push({ path: f, source: 'common' });
      }
    }
  } else {
    console.warn('⚠  docs/docs-common not found. Run: git submodule update --init --recursive');
  }

  return files;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const files = discoverFiles();
console.log(`Discovered ${files.length} .adoc files  (wpf + common)`);

const index: DocIndexEntry[] = [];
let written = 0;
let skipped = 0;
const slugSeen = new Set<string>();

for (const { path, source } of files) {
  const entry = processFile(path, source);

  if (!entry) { skipped++; continue; }

  // Deduplicate: docs-wpf takes precedence over docs-common for the same slug
  if (slugSeen.has(entry.slug)) {
    if (source === 'common') { skipped++; continue; }
    // Replace existing common entry with wpf entry (update index + overwrite file)
    const idx = index.findIndex(e => e.slug === entry.slug);
    if (idx !== -1) index.splice(idx, 1);
  }
  slugSeen.add(entry.slug);

  const { body, xamlSnippets, ...indexEntry } = entry;

  // Write full content file
  writeFileSync(
    join(OUT_DIR, `${entry.slug}.json`),
    JSON.stringify(entry, null, 2),
  );

  index.push(indexEntry);
  written++;
}

// Sort index alphabetically by slug for deterministic output
index.sort((a, b) => a.slug.localeCompare(b.slug));

writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

assertBuildStep(written > 0,
  `Submodules are present, but 0 doc topics were written (${files.length} .adoc files discovered, ` +
  `${skipped} skipped). This means the submodules are populated but the parsing logic no longer ` +
  `matches their real file layout/metadata format — a data-shape drift, not a missing dependency. ` +
  `Needs a code fix in build-docs.ts, not a submodule re-init.`
);

console.log(`\nDone.`);
console.log(`  Topics written : ${written}`);
console.log(`  Skipped        : ${skipped}  (no metadata or empty)`);
console.log(`  Index          : ${INDEX_FILE}`);
console.log(`  Full content   : ${OUT_DIR}/  (${written} files)`);
