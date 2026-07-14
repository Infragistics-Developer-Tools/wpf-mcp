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

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
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
  const re = /<member\s+name="([TPMEFtpmef]):([^"]+)">([\s\S]*?)<\/member>/g;
  const results: RawMember[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const [, kind, fullName, body] = m;
    const shortName = fullName.replace(/\(.*$/, '').split('.').pop() ?? '';
    if (!shortName || shortName.startsWith('get_') || shortName.startsWith('set_') || shortName.startsWith('.')) continue;
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

/** Second pass: enrich each API file with inherited Infragistics properties. */
function enrichWithInheritance(typeInfo: Record<string, TypeInfoEntry | string>): number {
  const files = readdirSync(API_OUT_DIR).filter((f: string) => f.endsWith('.json'));
  let enriched = 0;

  for (const file of files) {
    const typeName = file.replace('.json', '');
    if (!(`${typeName}.__baseType` in typeInfo)) continue;

    const filePath = join(API_OUT_DIR, file);
    const entry = JSON.parse(readFileSync(filePath, 'utf-8')) as ApiEntry;
    const knownProps = new Set(entry.properties.map(p => p.name));
    let added = false;
    let current = typeName;

    while (true) {
      const base = typeInfo[`${current}.__baseType`];
      if (!base || typeof base !== 'string') break;

      const basePath = join(API_OUT_DIR, `${base}.json`);
      if (!existsSync(basePath)) break;

      const baseEntry = JSON.parse(readFileSync(basePath, 'utf-8')) as ApiEntry;
      const baseDirectProps = baseEntry.properties.filter(
        p => !p.declaredOn && !knownProps.has(p.name)
      );

      for (const p of baseDirectProps) {
        entry.properties.push({ ...p, declaredOn: base });
        knownProps.add(p.name);
        added = true;
      }
      current = base;
    }

    if (added) {
      writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
      enriched++;
    }
  }
  return enriched;
}

function generate() {
  mkdirSync(API_OUT_DIR, { recursive: true });

  const typeInfo = loadTypeInfo();
  const sources = discoverXmlFiles();
  console.log(`Scanning ${sources.length} XML documentation files...`);

  const registry: RegistryEntry[] = [];
  const seenTypes = new Set<string>();
  let apiCount = 0;

  for (const { xmlPath, packageId } of sources) {
    const xml = readFileSync(xmlPath, 'utf-8');

    const assemblyMatch = xml.match(/<assembly>\s*<name>([^<]+)<\/name>/);
    if (!assemblyMatch) continue;
    const assemblyName = assemblyMatch[1].trim();
    const xmlnsInfo = ASSEMBLY_XMLNS[assemblyName] ?? DEFAULT_XMLNS;

    const members = parseAllMembers(xml);
    const types = members.filter(m => m.kind === 'T' && m.fullName.startsWith('Infragistics.'));

    for (const type of types) {
      const typeName = type.name;
      if (shouldExclude(typeName)) continue;
      if (seenTypes.has(typeName)) continue; // deduplicate across packages
      seenTypes.add(typeName);

      const dotnetNs = type.fullName.substring(0, type.fullName.lastIndexOf('.'));
      const typePrefix = `${type.fullName}.`;

      const entry: ApiEntry = {
        component:      typeName,
        assembly:       assemblyName,
        nugetPackage:   packageId,
        xamlNamespace:  xmlnsInfo.xmlns,
        defaultPrefix:  xmlnsInfo.prefix,
        dotnetNamespace: dotnetNs,
        summary:        type.summary,
        remarks:        type.remarks,
        properties: members.filter(m => m.kind === 'P' && m.fullName.startsWith(typePrefix))
                           .map(m => {
                             const ti = typeInfo[`${typeName}.${m.name}`];
                             const extra = (ti && typeof ti === 'object') ? ti : {};
                             return { name: m.name, summary: m.summary, ...extra };
                           }),
        events:     members.filter(m => m.kind === 'E' && m.fullName.startsWith(typePrefix))
                           .map(m => ({ name: m.name, summary: m.summary })),
        methods:    members.filter(m => m.kind === 'M' && m.fullName.startsWith(typePrefix) && !m.name.startsWith('#'))
                           .map(m => ({ name: m.name, summary: m.summary })),
      };

      writeFileSync(join(API_OUT_DIR, `${typeName}.json`), JSON.stringify(entry, null, 2), 'utf-8');
      apiCount++;

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
  }

  registry.sort((a, b) => a.component.localeCompare(b.component));
  writeFileSync(NS_OUT_FILE, JSON.stringify(registry, null, 2), 'utf-8');

  const enriched = enrichWithInheritance(typeInfo);

  console.log(`Done.`);
  console.log(`  API files:  ${apiCount} \u2192 src/data/api/`);
  console.log(`  Enriched:   ${enriched} types with inherited Infragistics properties`);
  console.log(`  Registry:   ${registry.length} Xam* controls → src/data/namespaces.json`);
}

generate();
