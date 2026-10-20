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

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, promises as fsPromises } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assertBuildStep } from './build-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT          = join(__dirname, '..');
const PACKAGES_DIR  = join(ROOT, 'nuget', 'packages');
const API_OUT_DIR   = join(ROOT, 'src', 'data', 'api');
const NS_OUT_FILE   = join(ROOT, 'src', 'data', 'namespaces.json');

// ── Type name exclusion list ──────────────────────────────────────────────────
const EXCLUDE_SUFFIXES = [
  'AutomationPeer', 'EventArgs', 'Converter', 'Exception', 'Factory',
  'Designer', 'Adorner', 'Behavior', 'Action', 'Command',
];
const EXCLUDE_CONTAINS = ['Internal', '<>', 'AnonymousType'];

// XamXGrid is public and used internally for xplat components, but may
// become customer-facing later, so this is a plain omission, not a "deprecated" label.
const EXCLUDE_PACKAGES = ['infragistics.wpf.controls.grids.xamxgrid.trial'];

function shouldExclude(typeName: string): boolean {
  return (
    EXCLUDE_SUFFIXES.some(s => typeName.endsWith(s)) ||
    EXCLUDE_CONTAINS.some(s => typeName.includes(s))
  );
}

/**
 * Newest-first ordering for NuGet version folder names.
 * A plain string sort ranks "26.1.9" above "26.1.21", so it picks the older package
 * whenever two versions of the same package are present in nuget/packages.
 */
function byVersionDesc(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isInteger(na) && Number.isInteger(nb)) {
      if (na !== nb) return nb - na;
    } else {
      const cmp = (pb[i] ?? '').localeCompare(pa[i] ?? '');
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
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
const TFM_PREF = ['net10.0-windows7.0', 'net9.0-windows7.0', 'net8.0-windows7.0', 'net40'];

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
    const versions = readdirSync(pkgDir).sort(byVersionDesc);
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

  assertBuildStep(sources.length > 0,
    `nuget/packages/ exists, but 0 Infragistics XML doc files were found inside it — the ` +
    `restore ran but didn't actually populate any "infragistics.wpf*" packages (wrong feed, ` +
    `version mismatch, or a partial/failed restore). Check nuget/WpfDocs.csproj and your NuGet ` +
    `source config, then re-run: npm run docs:restore`
  );

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
  /** A static ResourceKey/RoutedCommand field (used via {x:Static}), listed with the properties. */
  isField?: boolean;
}

export interface AlternateType {
  fullName: string;
  nugetPackage: string;
  memberCount: number;
}

export interface ApiEntry {
  component: string;
  assembly: string;
  nugetPackage: string;
  xamlNamespace: string;
  defaultPrefix: string;
  dotnetNamespace: string;
  /** Set only for nested types: their XAML name, e.g. "DataPresenterRoyalDark+Locator". */
  xamlName?: string;
  summary: string;
  remarks: string;
  /** Immediate base type name, if it is also an indexed Infragistics type. */
  baseType?: string;
  /** Set only when other Infragistics types share this short name. */
  alternates?: AlternateType[];
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
  isField?: boolean;
}

/** XAML namespace of one type, resolved by the type extractor (see "Phase 3" in type-extractor/Program.cs). */
interface XamlTypeInfo { xmlns: string; prefix: string; ns: string; xamlName?: string }

function loadTypeInfo(): Record<string, TypeInfoEntry | string> {
  const path = join(ROOT, 'nuget', 'type-info.json');
  assertBuildStep(existsSync(path),
    `nuget/type-info.json not found. Without it, every type's properties silently lose their ` +
    `real typeName/isNullable/isEnum/enumValues/baseType — the build would still "succeed" but ` +
    `quietly ship degraded API data. Run: npm run generate:types`
  );
  const raw = readFileSync(path, 'utf-8');
  const result: Record<string, TypeInfoEntry | string> = {};
  // The regexes capture raw JSON string contents, and System.Text.Json escapes ` < > + as ` etc.: decode them,
  // or "DataPresenterResourceSet`1" never matches and "Action<ToolCommand>" reaches agents as "Action<ToolCommand>".
  const decode = (s: string): string => JSON.parse(`"${s}"`);

  // Parse property (and static field) type entries
  const re = /"([^"]+)":\{"typeName":"([^"]+)","isNullable":(true|false),"isEnum":(true|false)(?:,"enumValues":\[([^\]]*)])?(?:,"isField":(true))?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const enumValuesRaw = m[5];
    const entry: TypeInfoEntry = {
      typeName:   decode(m[2]),
      isNullable: m[3] === 'true',
      isEnum:     m[4] === 'true',
      enumValues: enumValuesRaw
        ? enumValuesRaw.replace(/"/g, '').split(',').filter(Boolean).map(decode)
        : undefined,
    };
    if (m[6]) entry.isField = true;
    result[decode(m[1])] = entry;
  }
  return result;
}

/**
 * The extractor's maps keyed by "Assembly|Namespace.Type" (nested: "…|Namespace.Outer.Inner"), so types that share
 * a short name can't overwrite each other: each type's XAML namespace and prefix, and its Infragistics base type.
 */
function loadExtractorMaps(): { xaml: Record<string, XamlTypeInfo>; baseTypes: Record<string, string>; nonPublic: Set<string> } {
  const parsed = JSON.parse(readFileSync(join(ROOT, 'nuget', 'type-info.json'), 'utf-8'));
  const xaml = parsed.__xaml as Record<string, XamlTypeInfo> | undefined;
  const baseTypes = parsed.__baseTypes as Record<string, string> | undefined;
  const nonPublic = parsed.__nonPublicTypes as string[] | undefined;
  assertBuildStep(!!xaml && Object.keys(xaml).length > 0 && !!baseTypes && Object.keys(baseTypes).length > 0 && !!nonPublic?.length,
    `nuget/type-info.json has no "__xaml" / "__baseTypes" / "__nonPublicTypes" section — it was written by an older ` +
    `type extractor, so every type would get a guessed xmlns, no inherited members, and internal classes would be ` +
    `indexed as usable. Run: npm run generate:types`
  );
  return { xaml: xaml!, baseTypes: baseTypes!, nonPublic: new Set(nonPublic) };
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
  baseTypes: Record<string, string>
): number {
  let enriched = 0;
  const fullKey = (e: ApiEntry) => `${e.assembly}|${e.dotnetNamespace}.${e.component}`;

  for (const entry of entries.values()) {
    const immediateBase = baseTypes[fullKey(entry)];
    if (!immediateBase) continue;
    entry.baseType = immediateBase.split('.').pop()!;

    const knownProps  = new Set(entry.properties.map(p => p.name));
    const knownEvents = new Set(entry.events.map(e => e.name));
    const knownMethods = new Set(entry.methods.map(m => m.name));
    const visited = new Set<string>([fullKey(entry)]);
    let added = false;
    let current = fullKey(entry);

    while (true) {
      const baseKey = baseTypes[current];
      if (!baseKey) break;
      if (visited.has(baseKey)) break;   // cycle guard
      visited.add(baseKey);

      // Entries are keyed by short name; only follow it if that entry IS this base type, not a same-named one.
      const base = baseKey.split('.').pop()!;
      const baseEntry = entries.get(base);
      if (!baseEntry || fullKey(baseEntry) !== baseKey) break;

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
      current = baseKey;
    }

    if (added) enriched++;
  }
  return enriched;
}

async function generate() {
  // Rebuilt from scratch every run so renamed/removed types can't linger as orphans.
  rmSync(API_OUT_DIR, { recursive: true, force: true });
  mkdirSync(API_OUT_DIR, { recursive: true });

  const typeInfo = loadTypeInfo();
  const { xaml: xamlTypes, baseTypes, nonPublic } = loadExtractorMaps();
  let skippedNonPublic = 0;
  // Prefix per xmlns, for the few types the extractor has no entry for (generics, DLLs left out of XAML resolution).
  const prefixByXmlns = new Map(Object.values(xamlTypes).map(x => [x.xmlns, x.prefix]));
  const xamlFallbacks: string[] = [];
  const discovered = discoverXmlFiles();
  const sources = discovered.filter(s => !EXCLUDE_PACKAGES.includes(s.packageId));
  console.log(`Scanning ${sources.length} XML documentation files...`);

  const entries = new Map<string, ApiEntry>();
  // Entries are keyed by short type name, but short names are not unique across
  // assemblies. Collisions are resolved case-INsensitively: type files are named after
  // the key, so on Windows "strings" and "Strings" would otherwise be written to the
  // same path concurrently and interleave into invalid JSON. loadApiDoc() also resolves
  // names case-insensitively, so a case-variant twin is unreachable regardless.
  const keyByLower = new Map<string, string>();
  const memberCounts = new Map<string, number>();
  const alternates = new Map<string, AlternateType[]>();

  for (let fileIdx = 0; fileIdx < sources.length; fileIdx++) {
    const { xmlPath, packageId } = sources[fileIdx];
    const fileName = xmlPath.split(/[\\/]/).pop()!;
    const t0 = Date.now();
    process.stdout.write(`  [${fileIdx + 1}/${sources.length}] ${fileName} ... `);

    const xml = readFileSync(xmlPath, 'utf-8');

    const assemblyMatch = xml.match(/<assembly>\s*<name>([^<]+)<\/name>/);
    if (!assemblyMatch) { console.log('skip (no assembly)'); continue; }
    const assemblyName = assemblyMatch[1].trim();

    const members = parseAllMembers(xml);

    // Build lookup maps once per file — O(n) instead of O(n × types)
    const typeMembers = new Map<string, { props: RawMember[]; fields: RawMember[]; events: RawMember[]; methods: RawMember[] }>();
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
      if (!typeMembers.has(typeFqn)) typeMembers.set(typeFqn, { props: [], fields: [], events: [], methods: [] });
      const bucket = typeMembers.get(typeFqn)!;
      if (m.kind === 'P') bucket.props.push(m);
      else if (m.kind === 'F') bucket.fields.push(m);   // kept below only if the extractor marked it isField
      else if (m.kind === 'E') bucket.events.push(m);
      else if (m.kind === 'M' && !m.name.startsWith('#')) bucket.methods.push(m);
    }

    for (const type of typeList) {
      if (!type.fullName.startsWith('Infragistics.')) continue;
      const typeName = type.name;
      if (shouldExclude(typeName)) continue;
      // The XML docs also document internal / private nested classes, which apps can't use. Leaving them out here,
      // before short-name collisions are resolved, also lets a public type win its name (DashboardTileGroupDescription).
      if (nonPublic.has(`${assemblyName}|${type.fullName}`)) { skippedNonPublic++; continue; }

      // For a nested type this is "Namespace.Outer", which keeps the C# full name right; xamlName carries "Outer+Inner".
      const dotnetNs = type.fullName.substring(0, type.fullName.lastIndexOf('.'));
      const bucket = typeMembers.get(type.fullName) ?? { props: [], fields: [], events: [], methods: [] };

      let xaml = xamlTypes[`${assemblyName}|${type.fullName}`];
      if (!xaml) {
        // No resolved entry (open generics can't be named in XAML; DLLs the extractor left out of XAML resolution):
        // clr-namespace syntax, which needs no xmlns mapping.
        const xmlns = `clr-namespace:${dotnetNs};assembly=${assemblyName}`;
        xaml = { xmlns, prefix: prefixByXmlns.get(xmlns) ?? `ig${dotnetNs.split('.').pop()}`, ns: dotnetNs };
        xamlFallbacks.push(type.fullName);
      }

      const withTypeInfo = (m: RawMember) => {
        const ti = typeInfo[`${typeName}.${m.name}`];
        const extra = (ti && typeof ti === 'object') ? ti : {};
        return { name: m.name, summary: m.summary, ...extra };
      };

      const entry: ApiEntry = {
        component:      typeName,
        assembly:       assemblyName,
        nugetPackage:   packageId,
        xamlNamespace:  xaml.xmlns,
        defaultPrefix:  xaml.prefix,
        dotnetNamespace: dotnetNs,
        ...(xaml.xamlName ? { xamlName: xaml.xamlName } : {}),
        summary:        type.summary,
        remarks:        type.remarks,
        // Static key/command fields are listed with the properties: both are used the same way in XAML.
        properties: [
          ...bucket.props.filter(m => m.summary.toLowerCase() !== 'internal').map(withTypeInfo),
          ...bucket.fields.filter(m => m.summary.toLowerCase() !== 'internal').map(withTypeInfo)
                          .filter(f => (f as ApiMemberEntry).isField === true),
        ],
        events:     bucket.events
                           .filter(m => m.summary.toLowerCase() !== 'internal')
                           .map(m => ({ name: m.name, summary: m.summary })),
        methods:    bucket.methods
                           .filter(m => m.summary.toLowerCase() !== 'internal')
                           .map(m => ({ name: m.name, summary: m.summary })),
      };

      const memberCount = entry.properties.length + entry.events.length + entry.methods.length;
      const candidate: AlternateType = {
        fullName: type.fullName,
        nugetPackage: packageId,
        memberCount,
      };
      const lower = typeName.toLowerCase();
      const incumbentKey = keyByLower.get(lower);

      if (incumbentKey === undefined) {
        entries.set(typeName, entry);
        keyByLower.set(lower, typeName);
        memberCounts.set(lower, memberCount);
      } else {
        // Two different types share this short name. Discovery order is just
        // package-alphabetical, which surfaces stub types over the real control
        // (e.g. a 20-member XamComboEditor beating the 125-member one), so keep
        // whichever documents more members and record the other as an alternate.
        const incumbent = entries.get(incumbentKey)!;
        if (!alternates.has(lower)) alternates.set(lower, []);

        if (memberCount > memberCounts.get(lower)!) {
          alternates.get(lower)!.push({
            fullName: `${incumbent.dotnetNamespace}.${incumbent.component}`,
            nugetPackage: incumbent.nugetPackage,
            memberCount: memberCounts.get(lower)!,
          });
          entries.delete(incumbentKey);
          entries.set(typeName, entry);
          keyByLower.set(lower, typeName);
          memberCounts.set(lower, memberCount);
        } else {
          alternates.get(lower)!.push(candidate);
        }
      }
    }    console.log(`${Date.now() - t0}ms  (${members.length} members)`);
  }

  console.log(`Left out ${skippedNonPublic} non-public (internal / private nested) type(s) documented in the XML.`);
  const genericFallbacks = xamlFallbacks.filter(n => n.includes('`')).length;
  console.log(`XAML namespaces: ${xamlFallbacks.length} type(s) fell back to clr-namespace syntax ` +
    `(${genericFallbacks} generic, ${xamlFallbacks.length - genericFallbacks} other${xamlFallbacks.length > genericFallbacks ? `: ${xamlFallbacks.filter(n => !n.includes('`')).slice(0, 8).join(', ')}` : ''})`);

  for (const [lower, alts] of alternates) {
    const winner = entries.get(keyByLower.get(lower)!);
    if (winner) winner.alternates = alts.sort((a, b) => b.memberCount - a.memberCount);
  }

  // Enrich in-memory, then write everything at once
  console.log(`Enriching inheritance...`);
  const enriched = enrichWithInheritance(entries, baseTypes);

  const escaped = [...entries.values()].filter(e => /\\u00[0-9A-Fa-f]{2}/.test(JSON.stringify(e).replace(/\\\\/g, '')));
  assertBuildStep(escaped.length === 0,
    `${escaped.length} API entr${escaped.length === 1 ? 'y' : 'ies'} (e.g. ${escaped.slice(0, 3).map(e => e.component).join(', ')}) contain ` +
    `JSON escapes such as \\u003C as literal text — a type-info.json string was used without decode(), so agents would ` +
    `read "Action\\u003CToolCommand\\u003E" instead of "Action<ToolCommand>".`
  );

  console.log(`Writing ${entries.size} API files...`);
  await Promise.all(
    [...entries.entries()].map(([typeName, entry]) =>
      fsPromises.writeFile(join(API_OUT_DIR, `${typeName}.json`), JSON.stringify(entry), 'utf-8')
    )
  );

  // Built from the resolved winners, not during discovery, so a type that loses a
  // short-name collision can't leave a stale registry entry behind.
  const registry: RegistryEntry[] = [...entries.values()]
    .filter(e => e.component.startsWith('Xam'))
    .map(e => ({
      component:       e.component,
      xamlNamespace:   e.xamlNamespace,
      defaultPrefix:   e.defaultPrefix,
      dotnetNamespace: e.dotnetNamespace,
      nugetPackage:    e.nugetPackage,
      assembly:        e.assembly,
      description:     e.summary,
    }));

  assertBuildStep(
    new Set([...entries.keys()].map(k => k.toLowerCase())).size === entries.size,
    `Two API entries differ only in letter case. Their .json files would collide on a ` +
    `case-insensitive filesystem and interleave into invalid JSON — the collision resolution ` +
    `in generate() must stay case-insensitive.`
  );

  assertBuildStep(entries.size > 0 && registry.length > 0,
    `Discovered ${sources.length} XML doc file(s) but produced 0 API entries / registry components. ` +
    `This means the XML files are present but their content no longer matches what this script ` +
    `expects \u2014 a data-shape drift, not a missing dependency. Needs a code fix in build-api.ts.`
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
