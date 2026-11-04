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

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
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
// Excluded: data-grid (web / Blazor grid — WPF's XamDataGrid is in docs-wpf) and win-web-chart (the Windows Forms /
// ASP.NET UltraChart: DocsConfig.xml defines its {WawChartName} for those two products only, and its 359 topics
// never mention a WPF control).
const COMMON_INCLUDE = new Set([
  'barcodes', 'bullet-graph', 'category-chart', 'data-chart', 'data-pie-chart',
  'document-engine', 'donut-chart', 'excel-engine', 'financial-chart', 'funnel-chart',
  'geographic-map', 'linear-gauge', 'pie-chart', 'productivity-tools', 'radial-gauge',
  'scheduler', 'shape-chart', 'sparkline', 'spreadsheet', 'surface-chart',
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

// The attributes a WPF docs build sets: DocsConfig.xml's <Product Name="wpf" BuildFlags="xaml,wpf"/>.
function loadWpfBuildFlags(): Set<string> {
  if (!existsSync(DOCS_CONFIG_FILE)) return new Set(['xaml', 'wpf']);   // no docs-common (see loadWpfVariables): its value
  const flags = /<Product\s+Name="wpf"[^>]*?\sBuildFlags="([^"]*)"/.exec(readFileSync(DOCS_CONFIG_FILE, 'utf-8'))?.[1];
  assertBuildStep(!!flags,
    `DocsConfig.xml has no <Product Name="wpf" BuildFlags="…"/>, so there is no way to tell which ifdef:: blocks ` +
    `belong to WPF: every topic would keep the Windows Forms, Xamarin and Android variants too.`
  );
  return new Set(flags!.split(',').map(f => f.trim()).filter(Boolean));
}

const WPF_FLAGS = loadWpfBuildFlags();

/**
 * Keep only what a WPF build of the docs shows. docs-common writes each topic once for every platform and wraps the
 * platform-specific parts in `ifdef::wpf,win-forms[]` … `endif::…[]` (a comma means any of them); docs-wpf has a few
 * for Silverlight. That is the only conditional form the sources use. Blocks nest.
 */
/**
 * Inline wording per platform: `pick:[wpf,win-forms="text"]` (12,800 uses, one platform list each). The WPF one stays
 * as plain text; the rest ("In Java:", Xamarin wording) is dropped, as a WPF build does. The text runs to the closing
 * `"]` on the same line: it may contain `]` (links) and, in code samples, doubled quotes (`wpf=""C:\Book1.xls""`);
 * a few sources leave out the `=`.
 */
function resolvePicks(raw: string): string {
  return raw.replace(/pick:\[([\w,-]+)=?"([^\n]*?)"\]/g, (_, platforms: string, text: string) =>
    platforms.split(',').some(p => WPF_FLAGS.has(p.trim().toLowerCase())) ? text : '');
}

function applyConditionals(raw: string): { text: string; dropped: number } {
  const keep: boolean[] = [];
  const out: string[] = [];
  let dropped = 0;
  for (const line of raw.split('\n')) {
    const open = /^ifdef::([^\[]*)\[\]\s*$/.exec(line);
    if (open) { keep.push(open[1].split(',').some(a => WPF_FLAGS.has(a.trim()))); continue; }
    if (/^endif::[^\[]*\[\]\s*$/.test(line)) { keep.pop(); continue; }   // a stray endif (3 in the sources) is a no-op
    if (keep.every(Boolean)) out.push(line); else dropped += line.length + 1;
  }
  return { text: out.join('\n'), dropped };
}

/**
 * Replace {VarName} placeholders using the resolved WPF variable table.
 *
 * Unknown tokens are left verbatim, never blanked: the same `{Token}` syntax is used by
 * XAML (`{Binding}`), .NET format strings (`{0}`), chart label templates (`{Item}`,
 * `{Date}`) and AsciiDoc attributes (`{nbsp}`), none of which are DocsConfig variables.
 * Deleting them silently corrupts code samples; leaving them is at worst cosmetic.
 */
function resolveVars(text: string): string {
  return text.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, name) => WPF_VARS.get(name) ?? whole);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdocMetadata {
  name: string;
  controlName?: string[];
  tags?: string[];
  /** Platforms the whole topic is built for ("WPF", "sl", "WINFORMS", "ANDROID") and output formats ("docx-online"). */
  buildFlags?: string[];
}

// A topic built only for other platforms (WinForms, Android, Silverlight, Windows Phone): its buildFlags name platforms
// but none of WPF's. "docx-…" flags are output formats, not platforms, so a topic with only those stays.
function isForOtherPlatforms(meta: AdocMetadata | null): boolean {
  const platforms = (meta?.buildFlags ?? []).map(f => f.trim().toLowerCase()).filter(f => f && !f.startsWith('docx-'));
  return platforms.length > 0 && !platforms.some(f => WPF_FLAGS.has(f));
}

export interface DocIndexEntry {
  slug:         string;    // e.g. "xamdockmanager-add-content-to-a-contentpane"
  title:        string;    // e.g. "Add Content to a ContentPane"
  controlNames: string[];  // e.g. ["xamDockManager"]
  tags:         string[];  // e.g. ["How Do I", "Getting Started"]
  source:       'wpf' | 'common';
  summary:      string;    // first ~220 chars of plain body text
  /** Xam* names the topic mentions, lowercased → count, e.g. { "xammaskedinput": 4 }. Only when there are any. */
  mentions?:    Record<string, number>;
}

export interface DocEntry extends DocIndexEntry {
  body:         string;    // the topic as Markdown: # headings, code in ``` fences
  xamlSnippets: string[];  // extracted XAML-only code blocks
}

// ── AsciiDoc helpers ──────────────────────────────────────────────────────────

// Matches a localized sibling such as "datagrid-column-pinning.ja-JP".
const LOCALIZED_FILE = /\.[a-z]{2}-[A-Z]{2}$/;

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

// AsciiDoc source languages → Markdown fence languages.
const FENCE_LANG: Record<string, string> = { csharp: 'csharp', cs: 'csharp', 'c#': 'csharp', vb: 'vb', xaml: 'xml', xml: 'xml', js: 'js', javascript: 'js' };

/**
 * AsciiDoc → Markdown: headings as #, code blocks in ``` fences, other markup stripped to its text.
 * Code blocks (an optional [source,lang] line, then ---- … ---- or a .... literal block) are set aside first, so the
 * prose clean-up can't touch them: it deletes {Name} tokens and _underscore_ pairs, which turned
 * XAxisLabel="{}{Name}" into XAxisLabel="{}" and mangled C# fields.
 */
function stripAdoc(raw: string): string {
  const code: string[] = [];
  const prose = raw.replace(/\r\n?/g, '\n').replace(
    /^(?:\[source(?:\s*,\s*([^\],]*))?[^\]\n]*\][ \t]*\n)?(-{4,}|\.{4,})[ \t]*\n([\s\S]*?)\n\2[ \t]*$/gm,
    (_, lang: string | undefined, _fence, body: string) => {
      const key = (lang ?? '').trim().toLowerCase();
      code.push('```' + (FENCE_LANG[key] ?? key) + '\n' + body + '\n```');
      return `\u0000${code.length - 1}\u0000`;
    });
  return stripProse(prose).replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

function stripProse(raw: string): string {
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
    // AsciiDoc heading markers (= / == / === …) → Markdown (# / ## / ### …): get_wpf_doc pages at them
    .replace(/^(={1,6}) /gm, (_, level: string) => '#'.repeat(level.length) + ' ')
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
  const conditional = applyConditionals(raw);
  raw = resolvePicks(conditional.text);
  droppedChars += conditional.dropped;
  if (conditional.dropped > 0) topicsTrimmed++;

  const meta  = parseMetadata(raw);
  if (isForOtherPlatforms(meta)) { otherPlatformTopics++; return null; }
  const title = extractTitle(raw);

  // Some real topics (the whole financial-chart family, several data-chart ones) carry no
  // `name` in their metadata block. Fall back to the filename rather than dropping them,
  // but only when the file has a real heading — untitled files are fragments and data
  // dumps — and never for a localized copy, whose slug would duplicate the English topic.
  const fileSlug = basename(filePath, '.adoc');
  if (!meta?.name && (!title || LOCALIZED_FILE.test(fileSlug))) return null;

  const slug         = meta?.name?.trim() || fileSlug;
  const controlNames = (meta?.controlName ?? []).map(s => s.trim()).filter(Boolean);
  const tags         = (meta?.tags ?? []).map(s => s.trim()).filter(Boolean);
  const xamlSnippets = extractXamlSnippets(raw);
  const body         = stripAdoc(raw);

  // Summary: first ~220 printable chars of the body, without the Markdown heading and fence markers
  const summary = body.replace(/^```.*$/gm, '').replace(/^#{1,6} /gm, '').replace(/\s+/g, ' ').slice(0, 220).trim();

  if (!title && !summary) return null; // skip empty/broken files

  // The Xam* names the topic mentions (xamDataGrid, XamMaskedInput; not "xaml" or "Xamarin"): search_wpf_docs'
  // control filter also matches them, since many topics are tagged with a family (xamInputs, xamDataPresenter)
  // rather than with each control they cover.
  const mentions: Record<string, number> = {};
  for (const m of body.matchAll(/\b[Xx]am([A-Z][A-Za-z0-9]*)\b/g)) {
    const name = `xam${m[1]}`.toLowerCase();
    mentions[name] = (mentions[name] ?? 0) + 1;
  }

  return {
    slug, title, controlNames, tags, source, summary,
    ...(Object.keys(mentions).length ? { mentions } : {}),
    body, xamlSnippets,
  };
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

// Rebuilt from scratch every run so renamed/removed topics can't linger as orphans.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const files = discoverFiles();
console.log(`Discovered ${files.length} .adoc files  (wpf + common)`);

const index: DocIndexEntry[] = [];
let skipped = 0;
let droppedChars = 0, topicsTrimmed = 0, otherPlatformTopics = 0;
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
}

// Sort index alphabetically by slug for deterministic output
index.sort((a, b) => a.slug.localeCompare(b.slug));

writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

assertBuildStep(index.length > 0,
  `Submodules are present, but 0 doc topics were written (${files.length} .adoc files discovered, ` +
  `${skipped} skipped). This means the submodules are populated but the parsing logic no longer ` +
  `matches their real file layout/metadata format — a data-shape drift, not a missing dependency. ` +
  `Needs a code fix in build-docs.ts, not a submodule re-init.`
);

assertBuildStep(
  new Set(index.map(e => e.slug.toLowerCase())).size === index.length,
  `Two topics have slugs differing only in letter case. Their .json files collide on a ` +
  `case-insensitive filesystem, so one would silently overwrite the other.`
);

// A pick:[…] left in a written topic means resolvePicks' pattern no longer matches the sources' form.
const unresolvedPicks = index.filter(e => readFileSync(join(OUT_DIR, `${e.slug}.json`), 'utf-8').includes('pick:[')).map(e => e.slug);
assertBuildStep(unresolvedPicks.length <= 5,
  `${unresolvedPicks.length} topics still contain pick:[platform="…"] macros (e.g. ${unresolvedPicks.slice(0, 3).join(', ')}): ` +
  `resolvePicks no longer matches their form, so agents would read every platform's wording, Java and Xamarin included.`
);

// Fences are what get_wpf_doc's pages keep code apart by; none means the code-block pattern no longer matches.
const fenced = index.reduce((n, e) => n + (readFileSync(join(OUT_DIR, `${e.slug}.json`), 'utf-8').match(/```/g)?.length ?? 0) / 2, 0);
assertBuildStep(fenced > 1000,
  `Only ${fenced} code blocks came out as \`\`\` fences across ${index.length} topics — stripAdoc's code-block pattern ` +
  `([source,…] + ---- … ----) no longer matches the AsciiDoc sources, so code would reach agents as plain prose again.`
);

console.log(`\nDone.`);
console.log(`  Topics written : ${index.length}`);
console.log(`  Code blocks    : ${fenced}`);
console.log(`  Other platforms: ${otherPlatformTopics} topics built only for them left out; ${topicsTrimmed} topics lost ` +
  `${droppedChars} chars of non-WPF ifdef:: blocks (WPF flags: ${[...WPF_FLAGS].join(', ')})`);
console.log(`  Skipped        : ${skipped}  (no metadata or empty)`);
console.log(`  Index          : ${INDEX_FILE}`);
console.log(`  Full content   : ${OUT_DIR}/  (${index.length} files)`);
