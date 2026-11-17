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
import { join, dirname, basename, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { ensureSubmodules } from './ensure-submodules.js';
import { assertBuildStep } from './build-guard.js';

ensureSubmodules();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT            = join(__dirname, '..');
const DOCS_WPF_DIR    = join(ROOT, 'docs', 'docs-wpf',    'topics', 'en');
const DOCS_COMMON_DIR = join(ROOT, 'docs', 'docs-common', 'topics', 'en');
const DOCS_CONFIG_FILE = join(ROOT, 'docs', 'docs-common', 'DocsConfig.xml');
const DOCS_DIR        = join(ROOT, 'docs');
const OUT_DIR         = join(ROOT, 'src', 'data', 'docs');
const INDEX_FILE      = join(ROOT, 'src', 'data', 'docs-index.json');

// WPF-relevant subfolders from docs-common, each with the DocsConfig.xml variable naming the control it covers.
// Excluded: data-grid (web / Blazor grid — WPF's XamDataGrid is in docs-wpf), scheduler (the Xamarin.Forms
// XamScheduler, which the WPF packages don't have — WPF's XamSchedule family is in docs-wpf; the WPF table of contents,
// toc/master-wpf.toc, never links these topics, and as XamScheduler topics they matched "xamSchedule" searches by
// substring) and win-web-chart (the Windows Forms /
// ASP.NET UltraChart: DocsConfig.xml defines its {WawChartName} for those two products only, and its 359 topics
// never mention a WPF control).
// A topic whose metadata names no control gets its folder's (none of the 18 shape-chart topics names one, nor 19 of
// the 32 financial-chart ones), so search_wpf_docs' control filter ranks it with its siblings rather than below the
// release notes that only mention the control; a folder alias it names ("financial-chart") becomes that control too. excel-engine's {ExcelEngineName} is the "Infragistics Excel Engine"
// its other topics name. document-engine has no variable, and every one of its topics names its engine already;
// productivity-tools covers three tools (Control Configurator, App Map, Toolbox), so no one name fits.
const COMMON_FOLDERS = new Map<string, string | null>([
  ['barcodes', 'BarcodesName'], ['bullet-graph', 'BulletGraphName'], ['category-chart', 'CategoryChartName'],
  ['data-chart', 'DataChartName'], ['data-pie-chart', 'DataPieChartName'], ['document-engine', null],
  ['donut-chart', 'DoughnutChartName'], ['excel-engine', 'ExcelEngineName'], ['financial-chart', 'FinancialChartName'],
  ['funnel-chart', 'FunnelChartName'], ['geographic-map', 'GeoMapName'], ['linear-gauge', 'LinearGaugeName'],
  ['pie-chart', 'PieChartName'], ['productivity-tools', null], ['radial-gauge', 'RadialGaugeName'],
  ['shape-chart', 'ShapeChartName'], ['sparkline', 'SparklineName'], ['spreadsheet', 'SpreadsheetName'],
  ['surface-chart', 'SurfaceChartName'],
]);

// docs-common topics of a WPF folder that are not WPF's, though no buildFlags say so: productivity-tools.adoc and
// getting-started-with-control-configurators.adoc link them only inside ifdef::xamarin[] blocks, toc/master-wpf.toc
// doesn't list them, and their text is about Xamarin.Forms (App Map lays out a Xamarin.Forms app, the Toolbox drags
// Xamarin.Forms controls onto a page; WPF's data grid configurator is using-control-configurator-with-data-grid).
const COMMON_NOT_WPF = new Set([
  'productivity-tools/getting-started-with-app-map.adoc', 'productivity-tools/getting-started-with-toolbox.adoc',
  'productivity-tools/using-control-configurator-with-xamarin-data-grid.adoc',
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

const missingFolderVars = [...COMMON_FOLDERS.values()].filter(v => v && !WPF_VARS.has(v));
assertBuildStep(!existsSync(DOCS_CONFIG_FILE) || missingFolderVars.length === 0,
  `DocsConfig.xml has no wpf value for ${missingFolderVars.join(', ')} (COMMON_FOLDERS), so that folder's topics ` +
  `that name no control would get none, and search_wpf_docs' control filter would rank them below passing mentions.`
);

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
    if (open) { keep.push(open[1].split(',').some(a => WPF_FLAGS.has(a.trim().toLowerCase()))); continue; }   // one source writes ifdef::XAML[]
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

/** The control a docs-common folder covers: the wpf value of its COMMON_FOLDERS variable, if it has one. */
function folderControlOf(folder: string | undefined): string | null {
  const variable = folder ? COMMON_FOLDERS.get(folder) : null;
  return variable ? WPF_VARS.get(variable)! : null;
}

/** A metadata control name that is only the docs-common folder's name for its control: "financial-chart" or "FinancialChart" for XamFinancialChart. */
function isFolderAlias(name: string, folder: string, control: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(name) === norm(folder) || `xam${norm(name)}` === norm(control);
}

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
 * Without one, the first heading is the title when every other heading is below it: nuget-packages and
 * wpf-about-trial-assemblies open with `== Title` over `===` sections. A `== Topic Overview` or `== In This Topic`
 * followed by other `==` sections is a section, not a title.
 */
function extractTitle(raw: string): string {
  // Remove //// comment blocks so we don't match = inside JSON
  const withoutComments = raw.replace(/\/\/\/\/[\s\S]*?\/\/\/\//g, '');
  const headings: { level: number; text: string }[] = [];
  for (const line of withoutComments.split('\n')) {
    const m = line.match(/^(={1,6}) (.+)/);
    if (m?.[1] === '=') return m[2].trim();
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }
  const [first, ...rest] = headings;
  return first && rest.every(h => h.level > first.level) ? first.text : '';
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
    // Block delimiters (==== example blocks, ===== …) are not text: left in, "==== " became an empty "####" heading below,
    // and a bare "====" under a line makes it a Markdown heading
    .replace(/^={4,}[ \t]*$/gm, '')
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

// ── include:: directives ──────────────────────────────────────────────────────

// All but a handful of the sources start with a UTF-8 byte-order mark, which readFileSync keeps: it hid the `= Title`
// on line 1, and with it 86 topics that have no metadata name (all 18 shape-chart ones, for instance).
function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
}

const INCLUDE_LINE = /^include::([^\[\n]+)\[([^\]\n]*)\][ \t]*\r?$/;
// The files include:: lines pasted, and the include:: lines that pasted nothing (file:line → why), checked at the end.
const includedFiles = new Set<string>();
const brokenIncludes = new Map<string, string>();
const unsupportedIncludes = new Set<string>();

/**
 * Paste each `include::file.adoc[]` line's file in its place, as Asciidoctor does when the docs site is built: the path
 * is relative to the file the line is in, and the pasted file's own include:: lines are resolved in turn. 67 docs-wpf
 * topics are written this way, and the line used to be deleted: xamdatagrid-crossfieldrecordfiltering is a title,
 * Purpose and Required Background, then include::shared-crossfieldrecordfiltering.adoc[] with the whole explanation
 * and its samples. Every include in the sources has empty brackets; an attribute (leveloffset, tag, lines…) would
 * change what is pasted, so one is refused at the end rather than ignored. A missing file or a cycle pastes nothing.
 * A file with a title of its own that includes a whole topic (xamdatapresenter-field-grouping: its title, then
 * include::xamdatagrid-field-grouping.adoc[]) is that topic under its own title: the pasted title would be a second H1.
 */
function expandIncludes(raw: string, filePath: string, stack: string[] = [filePath], titled = /^= \S/m.test(raw)): string {
  return raw.split('\n').map((line, i) => {
    const m = INCLUDE_LINE.exec(line);
    if (!m) return line;
    const where = `${relative(DOCS_DIR, filePath).replace(/\\/g, '/')}:${i + 1}`;
    if (m[2].trim()) { unsupportedIncludes.add(`${where} ${line.trim()}`); return ''; }
    const target = resolve(dirname(filePath), m[1].trim());
    if (stack.includes(target)) { brokenIncludes.set(where, `include::${m[1]}[] is a cycle: that file is being pasted already`); return ''; }
    if (!existsSync(target)) { brokenIncludes.set(where, `include::${m[1]}[]: no such file`); return ''; }
    includedFiles.add(target);
    const pasted = readSource(target);
    return expandIncludes(titled ? pasted.replace(/^= \S.*$/m, '') : pasted, target, [...stack, target], titled || /^= \S/m.test(pasted));
  }).join('\n');
}

// ── File processor ────────────────────────────────────────────────────────────

/** `aliasOf`: the one file this file includes, when it has no text of its own (see the alias check in Main). */
interface ProcessedTopic { entry: DocEntry; aliasOf?: string }

function processFile({ path: filePath, source, folder }: FileSource): ProcessedTopic | null {
  let own: string;
  try {
    own = readSource(filePath);
  } catch {
    return null;
  }

  // Resolve {PlaceholderName} tokens (shared docs-common topics) into real WPF
  // control names before any parsing, so metadata/title/body all see the
  // resolved text (e.g. "XamCategoryChart" instead of "{CategoryChartName}"). The metadata is the file's own, read
  // before include:: pastes other files in: most of those have a metadata block too, only a comment where it's pasted.
  const meta = parseMetadata(resolveVars(own));
  let raw = resolveVars(expandIncludes(own, filePath));
  const conditional = applyConditionals(raw);
  raw = resolvePicks(conditional.text);
  droppedChars += conditional.dropped;
  if (conditional.dropped > 0) topicsTrimmed++;

  if (isForOtherPlatforms(meta)) { otherPlatformTopics++; return null; }
  const title = extractTitle(raw);

  // Some real topics (19 of the 32 financial-chart ones, all of shape-chart, the changelog and release notes) carry no
  // `name` in their metadata block, or no metadata at all. Fall back to the filename rather than dropping them,
  // but only when the file has a real heading — untitled files are fragments and data
  // dumps — and never for a localized copy, whose slug would duplicate the English topic.
  const fileSlug = basename(filePath, '.adoc');
  if (!meta?.name && (!title || LOCALIZED_FILE.test(fileSlug))) { if (!title) untitled.push(filePath); return null; }

  const slug         = meta?.name?.trim() || fileSlug;
  // A docs-common topic that names no control gets its folder's. An unresolved {Placeholder} names none
  // (data-pie-chart-data-binding's {DataDataPieChartName}, a typo), and the folder's own alias ("financial-chart",
  // "FinancialChart" in 13 financial-chart topics) stands for its control: an alias only half-matches the control
  // filter, so those topics ranked below the ones that name no control.
  const folderControl = folderControlOf(folder);
  const named         = (meta?.controlName ?? []).map(s => s.trim()).filter(s => s && !/\{[A-Za-z0-9_.-]+\}/.test(s))
    .map(s => folderControl && isFolderAlias(s, folder!, folderControl) ? folderControl : s);
  const controlNames  = named.length || !folderControl ? [...new Set(named)] : [folderControl];
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

  // A file whose only line of its own is one include:: (xamdatagrid-external-filtering-copy) is the included file again.
  const [onlyLine, ...moreLines] = own.replace(/\/\/\/\/[\s\S]*?\/\/\/\//g, '').split('\n').filter(l => l.trim());
  const included = onlyLine && !moreLines.length ? INCLUDE_LINE.exec(onlyLine)?.[1] : undefined;

  return {
    entry: {
      slug, title, controlNames, tags, source, summary,
      ...(Object.keys(mentions).length ? { mentions } : {}),
      body, xamlSnippets,
    },
    ...(included ? { aliasOf: resolve(dirname(filePath), included.trim()) } : {}),
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

/** `folder`: the docs-common folder (COMMON_FOLDERS key) the file is in. */
interface FileSource { path: string; source: 'wpf' | 'common'; folder?: string }

/** The COMMON_NOT_WPF files found, left out. */
const notWpf: string[] = [];

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
      if (!COMMON_FOLDERS.has(folder)) continue;
      const folderPath = join(DOCS_COMMON_DIR, folder);
      if (!statSync(folderPath).isDirectory()) continue;
      for (const f of collectAdoc(folderPath)) {
        const rel = relative(DOCS_COMMON_DIR, f).replace(/\\/g, '/');
        if (COMMON_NOT_WPF.has(rel)) notWpf.push(rel); else files.push({ path: f, source: 'common', folder });
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
const untitled: string[] = [];
// docs-common folder → its .adoc files and the topics written from them
const folderCounts = new Map<string, { files: number; topics: number }>();
for (const { folder } of files) {
  if (folder) folderCounts.set(folder, { files: (folderCounts.get(folder)?.files ?? 0) + 1, topics: 0 });
}

let topics: (ProcessedTopic & { file: FileSource })[] = [];
for (const file of files) {
  const topic = processFile(file);
  if (topic) topics.push({ ...topic, file }); else skipped++;
}

// A file that is only an include:: of another topic is that topic's second place in the table of contents (the 4
// xamdatagrid-external-*-copy files, xamdatapresenter-conftreeview-expind for xamtreegrid-conf-expansion-indicators):
// written too, it would be the same text under a second slug, listed twice in every search that finds it.
const topicFiles = new Set(topics.map(t => t.file.path));
const aliases = topics.filter(t => t.aliasOf && topicFiles.has(t.aliasOf));
topics = topics.filter(t => !aliases.includes(t));
skipped += aliases.length;

const fileName = (t: { file: FileSource }) => basename(t.file.path, '.adoc');
const where = (t: { file: FileSource }) => relative(DOCS_DIR, t.file.path).replace(/\\/g, '/');

// The docs site's address for a page is its file name, and where docs-wpf and docs-common both have a file, WPF's
// docs site serves the docs-common one: bulletgraph.html is the shared xamBulletGraph overview, not docs-wpf's
// bulletgraph.adoc (only its title, as are 8 of these 10), and resources-sample-bubble-data.html the shared
// BubbleDataSource the chart topics bind to, not docs-wpf's XML. docs-wpf's used to win.
const sharedFiles = new Set(topics.filter(t => t.file.source === 'common').map(t => fileName(t).toLowerCase()));
const shadowed = topics.filter(t => t.file.source === 'wpf' && sharedFiles.has(fileName(t).toLowerCase()));
topics = topics.filter(t => !shadowed.includes(t));
skipped += shadowed.length;

// A topic's slug is its metadata name, and a few files claim another's: six data-pie-chart files, its overview among
// them, are named "piechart-selection" (the pie chart's selection topic), whats-new-in-2017-volume-2
// "whats-new-in-2017-volume-1". The file named after it keeps the name and the others take their own file names. The
// first file read used to keep it (in docs-wpf, the last) and the rest were dropped unseen: piechart-selection was the
// data pie chart's Animation.
const claims = new Map<string, typeof topics>();
for (const t of topics) claims.set(t.entry.slug.toLowerCase(), [...(claims.get(t.entry.slug.toLowerCase()) ?? []), t]);
const renamed: string[] = [];
const sameAsNamed: typeof topics = [];
for (const [name, group] of claims) {
  if (group.length < 2) continue;
  const named = group.find(t => fileName(t).toLowerCase() === name);
  for (const t of group.filter(t => fileName(t).toLowerCase() !== name)) {
    // home-page.adoc is wpf-netadvantage-win-client-wpf.adoc byte for byte: the same topic again, not another one.
    if (named && t.entry.title === named.entry.title && t.entry.body === named.entry.body) { sameAsNamed.push(t); continue; }
    renamed.push(`${t.entry.slug} → ${fileName(t)} (${where(t)})`);
    t.entry.slug = fileName(t);
    // Its metadata is a copy of the other file's, controlName included: the seven data-pie-chart files that claim
    // piechart-selection and piechart-others-category name {PieChartName}, but are about XamDataPieChart, their folder's.
    const control = folderControlOf(t.file.folder);
    if (control) t.entry.controlNames = [control];
  }
}
topics = topics.filter(t => !sameAsNamed.includes(t));
skipped += sameAsNamed.length;

// Two topics left with one slug (two docs-common folders with a file of that name, or a file name that is another
// topic's metadata name) would overwrite each other's .json file; slugs differing only in letter case collide on a
// case-insensitive filesystem the same way.
const bySlug = new Map<string, string[]>();
for (const t of topics) bySlug.set(t.entry.slug.toLowerCase(), [...(bySlug.get(t.entry.slug.toLowerCase()) ?? []), where(t)]);
const collisions = [...bySlug].filter(([, paths]) => paths.length > 1);
assertBuildStep(collisions.length === 0,
  `Topics that would share a slug: ${collisions.map(([slug, paths]) => `${slug} (${paths.join(', ')})`).join('; ')}. ` +
  `A file named after a metadata name keeps it and the others take their own file names, so these need a new rule.`
);

// A file that other topics include and that has a metadata name but no title (configuring-template-field,
// shared-asynchronouspagingdatasource, the "xamdiagram … summary chart" tables) is not a page of its own: its text is
// in the topics that include it, and it was a third copy of xamdatagrid-X and xamdatapresenter-X in searches. It is
// still written, so get_wpf_doc opens its slug as before, but its index entry has nothing for search_wpf_docs to match.
let unsearchable = 0;
for (const { entry, file } of topics) {
  const { body, xamlSnippets, ...indexEntry } = entry;

  // Write full content file
  writeFileSync(
    join(OUT_DIR, `${entry.slug}.json`),
    JSON.stringify(entry, null, 2),
  );

  const fragment = !entry.title && includedFiles.has(file.path);
  if (fragment) unsearchable++;
  index.push(fragment ? { slug: entry.slug, title: '', controlNames: [], tags: [], source: entry.source, summary: '' } : indexEntry);
  if (file.folder) folderCounts.get(file.folder)!.topics++;
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

// An include:: that pasted nothing: a missing file is a broken link in the sources (logged for the docs team), but more
// than a few means the paths no longer resolve and topics like xamdatagrid-crossfieldrecordfiltering are stubs again.
for (const [line, why] of brokenIncludes) console.warn(`⚠  ${line}: ${why}`);
assertBuildStep(brokenIncludes.size <= 3,
  `${brokenIncludes.size} include:: lines pasted nothing (${[...brokenIncludes.keys()].slice(0, 3).join(', ')}): ` +
  `expandIncludes no longer finds the files they name, so the topics written with them lose that text.`
);
assertBuildStep(unsupportedIncludes.size === 0,
  `include:: lines with attributes, which expandIncludes doesn't apply: ${[...unsupportedIncludes].join('; ')}. ` +
  `Each changes what is pasted (leveloffset the heading levels, tag/tags/lines a part of the file): implement it.`
);
// An include:: line left in a written topic means INCLUDE_LINE no longer matches the sources' form.
const unexpanded = topics.filter(t => /^include::/m.test(t.entry.body)).map(t => t.entry.slug);
assertBuildStep(unexpanded.length === 0,
  `${unexpanded.length} topics still contain include:: lines (e.g. ${unexpanded.slice(0, 3).join(', ')}): ` +
  `INCLUDE_LINE no longer matches their form, so the text they include is missing.`
);

// A topic without a metadata name is kept only with a title. The byte-order mark nearly every source starts with once
// hid the title of 86 of them, and they were left out unseen: all of shape-chart, 19 of 32 financial-chart topics, the
// changelog. include:: fragments (shared-crossfieldrecordfiltering opens with a section, not a title) are left out
// too: their text is in the topics that include them.
const fragments = untitled.filter(f => includedFiles.has(f));
const untitledTopics = untitled.filter(f => !includedFiles.has(f));
assertBuildStep(untitledTopics.length <= 5,
  `${untitledTopics.length} topics that have no metadata name were left out because extractTitle found no title in them — the ` +
  `title detection no longer matches the sources (a byte-order mark or a new heading form), so whole families of ` +
  `topics (shape-chart, financial-chart, the release notes) would be missing from search_wpf_docs.`
);

// Every docs-common folder keeps a fair share of its topics: a folder renamed upstream would drop out of COMMON_FOLDERS
// unseen, and the lost titles above had taken shape-chart to 0 of 18 topics.
const thinFolders = !existsSync(DOCS_COMMON_DIR) ? [] : [...COMMON_FOLDERS.keys()]
  .map(f => ({ f, ...(folderCounts.get(f) ?? { files: 0, topics: 0 }) }))
  .filter(c => c.topics === 0 || c.topics < c.files / 3);
assertBuildStep(thinFolders.length === 0,
  `docs-common folders with too few topics written: ${thinFolders.map(c => `${c.f} (${c.topics} of ${c.files} files)`).join(', ')}. ` +
  `Either the folder is gone from docs/docs-common/topics/en (update COMMON_FOLDERS) or processFile drops its topics.`
);
// A COMMON_NOT_WPF file renamed or moved upstream would be a WPF topic again, unseen.
const notWpfMissing = [...COMMON_NOT_WPF].filter(f => !notWpf.includes(f));
assertBuildStep(!existsSync(DOCS_COMMON_DIR) || notWpfMissing.length === 0,
  `COMMON_NOT_WPF names files docs/docs-common/topics/en no longer has: ${notWpfMissing.join(', ')}. Find where they went ` +
  `and update the list, or the Xamarin.Forms topics are back in search_wpf_docs.`
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
  `${droppedChars} chars of non-WPF ifdef:: blocks (WPF flags: ${[...WPF_FLAGS].join(', ')}); ${notWpf.length} docs-common ` +
  `files that aren't WPF's left out (${notWpf.join(', ')})`);
console.log(`  Includes       : ${includedFiles.size} files pasted by include::, ${fragments.length} of them fragments that ` +
  `aren't topics and ${unsearchable} fragments with a metadata name written but not searchable; ${aliases.length} files ` +
  `that only include another topic left out (${aliases.map(fileName).join(', ')})`);
console.log(`  Shared names   : ${renamed.length} topics took their file name as slug, the name being another file's, and ` +
  `${sameAsNamed.length} left out as that file's copy (${sameAsNamed.map(where).join(', ')}):`);
for (const r of renamed) console.log(`                   ${r}`);
console.log(`  Same file      : ${shadowed.length} docs-wpf files left out for the docs-common file of the same name: ` +
  shadowed.map(t => `${where(t)} (${t.entry.slug})`).join(', '));
console.log(`  Skipped        : ${skipped}  (other platforms, ${untitled.length} untitled without a metadata name, ` +
  `include-only files, docs-wpf files a docs-common one replaces, copies of a named file, empty)`);
console.log(`  Index          : ${INDEX_FILE}`);
console.log(`  Full content   : ${OUT_DIR}/  (${index.length} files)`);
