#!/usr/bin/env tsx
/**
 * build-api.ts
 *
 * Generates src/data/api/{TypeName}.json  (one file per public Infragistics type)
 * and regenerates src/data/namespaces.json (Xam* controls only, used by list_wpf_components)
 *
 * Prerequisites: nuget/packages/ must be populated first.
 *   npm run docs:restore   ← dotnet restore, fills nuget/packages/
 *   npm run generate       ← this script
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, promises as fsPromises } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT          = join(__dirname, '..');
const PACKAGES_DIR  = join(ROOT, 'nuget', 'packages');
const API_OUT_DIR   = join(ROOT, 'src', 'data', 'api');
const NS_OUT_FILE   = join(ROOT, 'src', 'data', 'namespaces.json');

// ── XAML namespace map ────────────────────────────────────────────────────────
// Maps assembly name → XAML xmlns URI + recommended prefix.
// Sourced from [assembly: XmlnsDefinition] attributes; stable across versions.
const ASSEMBLY_XMLNS: Record<string, { xmlns: string; prefix: string }> = {
  'Infragistics.WPF.DataPresenter':               { xmlns: 'http://infragistics.com/DataPresenter',   prefix: 'igDP'            },
  'InfragisticsWPF.DataPresenter':                { xmlns: 'http://infragistics.com/DataPresenter',   prefix: 'igDP'            },
  'Infragistics.WPF.DockManager':                 { xmlns: 'http://infragistics.com/DockManager',     prefix: 'igDock'          },
  'InfragisticsWPF.DockManager':                  { xmlns: 'http://infragistics.com/DockManager',     prefix: 'igDock'          },
  'Infragistics.WPF.Ribbon':                      { xmlns: 'http://infragistics.com/Ribbon',          prefix: 'igRibbon'        },
  'InfragisticsWPF.Ribbon':                       { xmlns: 'http://infragistics.com/Ribbon',          prefix: 'igRibbon'        },
  'Infragistics.WPF.Editors':                     { xmlns: 'http://infragistics.com/Editors',         prefix: 'igEditors'       },
  'InfragisticsWPF.Editors':                      { xmlns: 'http://infragistics.com/Editors',         prefix: 'igEditors'       },
  'Infragistics.WPF.Documents.Excel':             { xmlns: 'http://infragistics.com/Excel',           prefix: 'igExcel'         },
  'InfragisticsWPF.Documents.Excel':              { xmlns: 'http://infragistics.com/Excel',           prefix: 'igExcel'         },
  'Infragistics.WPF.DataPresenter.ExcelExporter': { xmlns: 'http://infragistics.com/ExcelExporter',   prefix: 'igExcelExporter' },
  'InfragisticsWPF.DataPresenter.ExcelExporter':  { xmlns: 'http://infragistics.com/ExcelExporter',   prefix: 'igExcelExporter' },
  'Infragistics.WPF.DataPresenter.WordWriter':    { xmlns: 'http://infragistics.com/WordWriter',      prefix: 'igWordWriter'    },
  'InfragisticsWPF.DataPresenter.WordWriter':     { xmlns: 'http://infragistics.com/WordWriter',      prefix: 'igWordWriter'    },
  'Infragistics.WPF.Reporting':                   { xmlns: 'http://infragistics.com/Reporting',       prefix: 'igRep'           },
  'InfragisticsWPF.Reporting':                    { xmlns: 'http://infragistics.com/Reporting',       prefix: 'igRep'           },
  'Infragistics.WPF.OutlookBar':                  { xmlns: 'http://infragistics.com/OutlookBar',      prefix: 'igOB'            },
  'InfragisticsWPF.OutlookBar':                   { xmlns: 'http://infragistics.com/OutlookBar',      prefix: 'igOB'            },
};
const DEFAULT_XMLNS = { xmlns: 'http://schemas.infragistics.com/xaml', prefix: 'ig' };

// ── Type name exclusion list ──────────────────────────────────────────────────
const EXCLUDE_SUFFIXES = [
  'AutomationPeer', 'EventArgs', 'Converter', 'Exception', 'Factory',
  'Designer', 'Adorner', 'Behavior', 'Action', 'Command',
];
const EXCLUDE_CONTAINS = ['Internal', '<>', 'AnonymousType'];

function shouldExclude(typeName: string): boolean {
  return (
    EXCLUDE_SUFFIXES.some(s => typeName.endsWith(s)) ||
    EXCLUDE_CONTAINS.some(s => typeName.includes(s))
  );
}

// ── XML parsing ───────────────────────────────────────────────────────────────
function stripXml(text: string): string {
  return text
    .replace(/<see\s+cref="[TPMFEtpmfe]:([^"]+)"\s*\/>/g, (_, ref) => ref.split('.').pop() ?? ref)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripXml(m[1]) : '';
}

interface RawMember { kind: string; fullName: string; name: string; summary: string; remarks: string }

function parseAllMembers(xml: string): RawMember[] {
  // Split on <member so each chunk is small — avoids [\s\S]*? on a multi-MB file
  const nameRe = /^name="([TPMEFtpmef]):([^"]+)"/;
  const results: RawMember[] = [];
  const chunks = xml.split('<member ');
  for (let i = 1; i < chunks.length; i++) {  // skip index 0 (before first <member)
    const chunk = chunks[i];
    const nameMatch = nameRe.exec(chunk);
    if (!nameMatch) continue;
    const [, kind, fullName] = nameMatch;
    const shortName = fullName.replace(/\(.*$/, '').split('.').pop() ?? '';
    if (!shortName || shortName.startsWith('get_') || shortName.startsWith('set_') || shortName.startsWith('.')) continue;
    // Body is everything after the closing > of the opening tag, up to </member>
    const gtIdx = chunk.indexOf('>');
    const endIdx = chunk.indexOf('</member>');
    const body = gtIdx >= 0 && endIdx > gtIdx ? chunk.substring(gtIdx + 1, endIdx) : '';
    results.push({ kind, fullName, name: shortName, summary: extractTag(body, 'summary'), remarks: extractTag(body, 'remarks') });
  }
  return results;
}

// ── File discovery ─────────────────────────────────────────────────────────────
const TFM_PREF = ['net8.0-windows7.0', 'net10.0-windows7.0', 'net9.0-windows7.0', 'net40'];

interface XmlSource { xmlPath: string; packageId: string }

function discoverXmlFiles(): XmlSource[] {
  if (!existsSync(PACKAGES_DIR)) {
    console.error('nuget/packages/ not found. Run: npm run docs:restore');
    process.exit(1);
  }

  const sources: XmlSource[] = [];
  const seen = new Set<string>();

  for (const pkgName of readdirSync(PACKAGES_DIR).sort()) {
    if (!pkgName.startsWith('infragistics.wpf')) continue;

    const pkgDir = join(PACKAGES_DIR, pkgName);
    const versions = readdirSync(pkgDir).sort().reverse();
    if (!versions.length) continue;
    const versionDir = join(pkgDir, versions[0]);

    for (const tfm of TFM_PREF) {
      const libDir = join(versionDir, 'lib', tfm);
      if (!existsSync(libDir)) continue;

      for (const f of readdirSync(libDir)) {
        if (!f.endsWith('.xml')) continue;
        const xmlPath = join(libDir, f);
        if (!seen.has(xmlPath)) {
          seen.add(xmlPath);
          sources.push({ xmlPath, packageId: pkgName });
        }
      }
      break; // use best matching TFM per package
    }
  }

  return sources;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export interface ApiMemberEntry {
  name: string;
  summary: string;
  typeName?: string;
  isNullable?: boolean;
  isEnum?: boolean;
  enumValues?: string[];
  declaredOn?: string;
}

export interface ApiEntry {
  component: string;
  assembly: string;
  nugetPackage: string;
  xamlNamespace: string;
  defaultPrefix: string;
  dotnetNamespace: string;
  summary: string;
  remarks: string;
  /** Immediate base type name, if it is also an indexed Infragistics type. */
  baseType?: string;
  properties: ApiMemberEntry[];
  events:     ApiMemberEntry[];
  methods:    ApiMemberEntry[];
}

export interface RegistryEntry {
  component: string;
  xamlNamespace: string;
  defaultPrefix: string;
  dotnetNamespace: string;
  nugetPackage: string;
  assembly: string;
  description: string;
}

interface TypeInfoEntry {
  typeName: string;
  isNullable: boolean;
  isEnum: boolean;
  enumValues?: string[];
}

function loadTypeInfo(): Record<string, TypeInfoEntry | string> {
  const path = join(ROOT, 'nuget', 'type-info.json');
  if (!existsSync(path)) {
    console.warn('type-info.json not found — run: npm run generate:types');
    return {};
  }
  const raw = readFileSync(path, 'utf-8');
  const result: Record<string, TypeInfoEntry | string> = {};

  // Parse __baseType string values  e.g. "XamCategoryChart.__baseType":"XamXYChart"
  const baseRe = /"([^"]+\.__baseType)":"([^"]+)"/g;
  let bm: RegExpExecArray | null;
  while ((bm = baseRe.exec(raw)) !== null) result[bm[1]] = bm[2];

  // Parse property type entries
  const re = /"([^"]+)":\{"typeName":"([^"]+)","isNullable":(true|false),"isEnum":(true|false)(?:,"enumValues":\[([^\]]*)])?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const enumValuesRaw = m[5];
    result[m[1]] = {
      typeName:   m[2],
      isNullable: m[3] === 'true',
      isEnum:     m[4] === 'true',
      enumValues: enumValuesRaw
        ? enumValuesRaw.replace(/"/g, '').split(',').filter(Boolean)
        : undefined,
    };
  }
  return result;
}

/**
 * Second pass: enrich every entry in-memory with inherited Infragistics members.
 * This walks the full base-type chain generically for ALL indexed types (properties,
 * events, and methods) — no per-component special-casing required. It also records
 * the immediate `baseType` on each entry so tools/descriptions can point callers to
 * the right base class dynamically instead of hardcoding examples.
 */
function enrichWithInheritance(
  entries: Map<string, ApiEntry>,
  typeInfo: Record<string, TypeInfoEntry | string>
): number {
  let enriched = 0;

  for (const [typeName, entry] of entries) {
    const immediateBase = typeInfo[`${typeName}.__baseType`];
    if (typeof immediateBase === 'string') entry.baseType = immediateBase;

    if (!(`${typeName}.__baseType` in typeInfo)) continue;

    const knownProps  = new Set(entry.properties.map(p => p.name));
    const knownEvents = new Set(entry.events.map(e => e.name));
    const knownMethods = new Set(entry.methods.map(m => m.name));
    const visited = new Set<string>([typeName]);
    let added = false;
    let current = typeName;

    while (true) {
      const base = typeInfo[`${current}.__baseType`];
      if (!base || typeof base !== 'string') break;
      if (visited.has(base)) break;   // cycle guard
      visited.add(base);

      const baseEntry = entries.get(base);
      if (!baseEntry) break;

      for (const p of baseEntry.properties.filter(p => !p.declaredOn && !knownProps.has(p.name))) {
        entry.properties.push({ ...p, declaredOn: base });
        knownProps.add(p.name);
        added = true;
      }
      for (const e of baseEntry.events.filter(e => !e.declaredOn && !knownEvents.has(e.name))) {
        entry.events.push({ ...e, declaredOn: base });
        knownEvents.add(e.name);
        added = true;
      }
      for (const m of baseEntry.methods.filter(m => !m.declaredOn && !knownMethods.has(m.name))) {
        entry.methods.push({ ...m, declaredOn: base });
        knownMethods.add(m.name);
        added = true;
      }
      current = base;
    }

    if (added) enriched++;
  }
  return enriched;
}

async function generate() {
  mkdirSync(API_OUT_DIR, { recursive: true });

  const typeInfo = loadTypeInfo();
  const sources = discoverXmlFiles();
  console.log(`Scanning ${sources.length} XML documentation files...`);

  const registry: RegistryEntry[] = [];
  const entries = new Map<string, ApiEntry>();
  const seenTypes = new Set<string>();

  for (let fileIdx = 0; fileIdx < sources.length; fileIdx++) {
    const { xmlPath, packageId } = sources[fileIdx];
    const fileName = xmlPath.split(/[\\/]/).pop()!;
    const t0 = Date.now();
    process.stdout.write(`  [${fileIdx + 1}/${sources.length}] ${fileName} ... `);

    const xml = readFileSync(xmlPath, 'utf-8');

    const assemblyMatch = xml.match(/<assembly>\s*<name>([^<]+)<\/name>/);
    if (!assemblyMatch) { console.log('skip (no assembly)'); continue; }
    const assemblyName = assemblyMatch[1].trim();
    const xmlnsInfo = ASSEMBLY_XMLNS[assemblyName] ?? DEFAULT_XMLNS;

    const members = parseAllMembers(xml);

    // Build lookup maps once per file — O(n) instead of O(n × types)
    const typeMembers = new Map<string, { props: RawMember[]; events: RawMember[]; methods: RawMember[] }>();
    const typeList: RawMember[] = [];
    for (const m of members) {
      if (m.kind === 'T') { typeList.push(m); continue; }
      // m.fullName for a member is "Namespace.TypeName.MemberName(Param1,Param2)" — strip
      // the parameter list FIRST, since parameter types (e.g. "System.String") contain
      // dots of their own and would otherwise make lastIndexOf('.') land inside them
      // instead of before the member name, silently dropping the member from its type.
      const memberPath = m.fullName.replace(/\(.*$/, '');
      const lastDot = memberPath.lastIndexOf('.');
      if (lastDot < 0) continue;
      const typeFqn = memberPath.substring(0, lastDot);
      if (!typeMembers.has(typeFqn)) typeMembers.set(typeFqn, { props: [], events: [], methods: [] });
      const bucket = typeMembers.get(typeFqn)!;
      if (m.kind === 'P') bucket.props.push(m);
      else if (m.kind === 'E') bucket.events.push(m);
      else if (m.kind === 'M' && !m.name.startsWith('#')) bucket.methods.push(m);
    }

    for (const type of typeList) {
      if (!type.fullName.startsWith('Infragistics.')) continue;
      const typeName = type.name;
      if (shouldExclude(typeName)) continue;
      if (seenTypes.has(typeName)) continue;
      seenTypes.add(typeName);

      const dotnetNs = type.fullName.substring(0, type.fullName.lastIndexOf('.'));
      const bucket = typeMembers.get(type.fullName) ?? { props: [], events: [], methods: [] };

      const entry: ApiEntry = {
        component:      typeName,
        assembly:       assemblyName,
        nugetPackage:   packageId,
        xamlNamespace:  xmlnsInfo.xmlns,
        defaultPrefix:  xmlnsInfo.prefix,
        dotnetNamespace: dotnetNs,
        summary:        type.summary,
        remarks:        type.remarks,
        properties: bucket.props
                           .filter(m => m.summary.toLowerCase() !== 'internal')
                           .map(m => {
                             const ti = typeInfo[`${typeName}.${m.name}`];
                             const extra = (ti && typeof ti === 'object') ? ti : {};
                             return { name: m.name, summary: m.summary, ...extra };
                           }),
        events:     bucket.events
                           .filter(m => m.summary.toLowerCase() !== 'internal')
                           .map(m => ({ name: m.name, summary: m.summary })),
        methods:    bucket.methods
                           .filter(m => m.summary.toLowerCase() !== 'internal')
                           .map(m => ({ name: m.name, summary: m.summary })),
      };

      entries.set(typeName, entry);

      // Registry: Xam* controls only (used by list_wpf_components)
      if (typeName.startsWith('Xam')) {
        registry.push({
          component:      typeName,
          xamlNamespace:  xmlnsInfo.xmlns,
          defaultPrefix:  xmlnsInfo.prefix,
          dotnetNamespace: dotnetNs,
          nugetPackage:   packageId,
          assembly:       assemblyName,
          description:    type.summary,
        });
      }
    }
    console.log(`${Date.now() - t0}ms  (${members.length} members)`);
  }

  // Enrich in-memory, then write everything at once
  console.log(`Enriching inheritance...`);
  const enriched = enrichWithInheritance(entries, typeInfo);

  console.log(`Writing ${entries.size} API files...`);
  await Promise.all(
    [...entries.entries()].map(([typeName, entry]) =>
      fsPromises.writeFile(join(API_OUT_DIR, `${typeName}.json`), JSON.stringify(entry), 'utf-8')
    )
  );

  registry.sort((a, b) => a.component.localeCompare(b.component));
  writeFileSync(NS_OUT_FILE, JSON.stringify(registry, null, 2), 'utf-8');

  // Search index — lightweight flat array, loaded once at MCP startup
  const searchIndex = [...entries.values()].map(e => ({
    n: e.component,
    s: e.summary,
    a: e.assembly,
    p: e.nugetPackage,
    m: [
      ...e.properties.map(x => x.name),
      ...e.events.map(x => x.name),
      ...e.methods.map(x => x.name),
    ],
  }));
  writeFileSync(
    join(ROOT, 'src', 'data', 'search-index.json'),
    JSON.stringify(searchIndex),
    'utf-8'
  );

  console.log(`Done.`);
  console.log(`  API files:    ${entries.size} → src/data/api/`);
  console.log(`  Enriched:     ${enriched} types with inherited Infragistics properties`);
  console.log(`  Registry:     ${registry.length} Xam* controls → src/data/namespaces.json`);
  console.log(`  Search index: ${searchIndex.length} types → src/data/search-index.json`);
}

generate();
