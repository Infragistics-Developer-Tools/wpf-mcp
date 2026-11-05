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
const EXCLUDE_PACKAGES = ['infragistics.wpf.controls.grids.xamxgrid.trial']; // compared lowercase

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
// The name a reference reads as: "M:Ns.Type.Save(System.Boolean)" → "Save", "T:Ns.Aggregator`1" → "Aggregator".
// Namespaces ("N:") and references the compiler couldn't resolve ("!:Field.Label") are kept whole.
function crefName(ref: string): string {
  const id = ref.replace(/^[A-Za-z!]+:/, '');
  if (/^[N!]:/.test(ref)) return id;
  return id.replace(/\(.*$/, '').replace(/~.*$/, '').split('.').pop()!.replace(/`+\d+$/, '');
}

// XML doc markup → plain text. References and <paramref>/<typeparamref>/<see langword> become the name or keyword
// they point to (dropping them left gaps like "over the specified ."); other tags keep their text.
function stripXml(text: string): string {
  return text
    .replace(/<(?:see|seealso)\s+cref="([^"]+)"\s*\/>/g, (_, ref) => crefName(ref))
    .replace(/<(?:paramref|typeparamref)\s+name="([^"]+)"\s*\/>/g, '$1')
    .replace(/<see\s+langword="([^"]+)"\s*\/>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    // A removed tag leaves a space before the punctuation after it: "is <c>null</c>." → "is null." Only punctuation
    // that ends a word, so "the .NET Framework" and "a value of .5" keep theirs.
    .replace(/\s+([.,;:!?)])(?=\s|$)/g, '$1').replace(/\(\s+/g, '(')
    .trim();
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripXml(m[1]) : '';
}

interface ParamDoc { name: string; summary: string }
interface RawMember { kind: string; fullName: string; name: string; summary: string; remarks: string; params?: ParamDoc[] }

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
    // Parameter descriptions tell overloads apart when they share a summary ("outputFormat: … (XPS only)").
    const params = kind === 'M'
      ? [...body.matchAll(/<param\s+name="([^"]+)"\s*>([\s\S]*?)<\/param>/g)]
          .map(p => ({ name: p[1], summary: stripXml(p[2]) })).filter(p => p.summary)
      : [];
    results.push({
      kind, fullName, name: shortName, summary: extractTag(body, 'summary'), remarks: extractTag(body, 'remarks'),
      ...(params.length ? { params } : {}),
    });
  }
  return results;
}

// ── File discovery ─────────────────────────────────────────────────────────────
const TFM_PREF = ['net10.0-windows7.0', 'net9.0-windows7.0', 'net8.0-windows7.0', 'net40'];

interface XmlSource { xmlPath: string; packageId: string }

// nuget/packages/ is NuGet's global-packages layout, whose folder names are the lowercased ID.
// The .nuspec keeps the canonical casing ("Infragistics.WPF.DataGrids.Trial"), which is what
// agents copy into a user's .csproj via `dotnet add package`.
function readPackageId(versionDir: string, folderName: string): string {
  const nuspec = join(versionDir, `${folderName}.nuspec`);
  const id = existsSync(nuspec) ? /<id>\s*([^<\s]+)\s*<\/id>/.exec(readFileSync(nuspec, 'utf8'))?.[1] : undefined;
  assertBuildStep(id?.toLowerCase() === folderName,
    `${nuspec}: expected an <id> matching the folder name "${folderName}", got ${id ? `"${id}"` : 'none'} — ` +
    `partial/failed restore? Re-run: npm run docs:restore`
  );
  return id!;
}

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
    const packageId = readPackageId(versionDir, pkgName);

    for (const tfm of TFM_PREF) {
      const libDir = join(versionDir, 'lib', tfm);
      if (!existsSync(libDir)) continue;

      for (const f of readdirSync(libDir)) {
        if (!f.endsWith('.xml')) continue;
        const xmlPath = join(libDir, f);
        if (!seen.has(xmlPath)) {
          seen.add(xmlPath);
          sources.push({ xmlPath, packageId });
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
  /** C# signature of a method, constructor or indexer: "void Export(OutputFormat outputFormat, string fileName)". */
  signature?: string;
  /** The XML docs' parameter descriptions (methods and constructors). */
  parameters?: ParamDoc[];
}

/** A member marked [Obsolete]: left out of the member lists, kept so a lookup by name gets the replacement. */
export interface ObsoleteMember {
  name: string;
  kind: 'property' | 'event' | 'method' | 'constructor';
  /** The [Obsolete] message, which usually names the replacement ("Please use the IsHorizontalZoomEnabled property."). */
  message: string;
  signature?: string;
  declaredOn?: string;
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
  /** Public constructors that take parameters (a parameterless one goes without saying). Only when there are any. */
  constructors?: ApiMemberEntry[];
  /** Only when there are any. */
  obsolete?: ObsoleteMember[];
  /** Set when the type itself is [Obsolete]: its message, which usually names the replacement. */
  obsoleteMessage?: string;
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

/** What reflection says about one member, keyed by "Assembly|<XML doc ID>" (see "__members" in type-extractor/Program.cs). */
interface MemberMeta { sig?: string; params?: string[]; overrides?: string; obsolete?: string; hidden?: boolean }

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
 * a short name can't overwrite each other: each type's XAML namespace and prefix, its Infragistics base type, the
 * types and members ("…|Namespace.Type.Member") that are not public, signatures and [Obsolete] / hidden flags by
 * doc ID ("…|M:Namespace.Type.Load(System.String)") for the types in memberTypes, and the doc IDs of their internal /
 * private methods and constructors.
 */
function loadExtractorMaps(): {
  xaml: Record<string, XamlTypeInfo>; baseTypes: Record<string, string>; nonPublic: Set<string>; nonPublicMembers: Set<string>;
  members: Record<string, MemberMeta>; nonPublicMethods: Set<string>; memberTypes: Set<string>;
} {
  const parsed = JSON.parse(readFileSync(join(ROOT, 'nuget', 'type-info.json'), 'utf-8'));
  const xaml = parsed.__xaml as Record<string, XamlTypeInfo> | undefined;
  const baseTypes = parsed.__baseTypes as Record<string, string> | undefined;
  const nonPublic = parsed.__nonPublicTypes as string[] | undefined;
  const nonPublicMembers = parsed.__nonPublicMembers as string[] | undefined;
  const members = parsed.__members as Record<string, MemberMeta> | undefined;
  const nonPublicMethods = parsed.__nonPublicMethods as string[] | undefined;
  const memberTypes = parsed.__memberTypes as string[] | undefined;
  assertBuildStep(!!xaml && Object.keys(xaml).length > 0 && !!baseTypes && Object.keys(baseTypes).length > 0 &&
    !!nonPublic?.length && !!nonPublicMembers?.length && !!members && Object.keys(members).length > 0 &&
    !!nonPublicMethods?.length && !!memberTypes?.length,
    `nuget/type-info.json has no "__xaml" / "__baseTypes" / "__nonPublicTypes" / "__nonPublicMembers" / "__members" / ` +
    `"__nonPublicMethods" / "__memberTypes" section — it was written by an older type extractor, so every type would get ` +
    `a guessed xmlns, no inherited members, internal classes and members would be indexed as usable, and methods would ` +
    `have no signatures. Run: npm run generate:types`
  );
  return {
    xaml: xaml!, baseTypes: baseTypes!, nonPublic: new Set(nonPublic), nonPublicMembers: new Set(nonPublicMembers),
    members: members!, nonPublicMethods: new Set(nonPublicMethods), memberTypes: new Set(memberTypes),
  };
}

// A method's overload, as the tail of its doc ID ("Export(Infragistics.Windows.Reporting.OutputFormat,System.String)"):
// an override has the same one as the base method, a sibling overload doesn't. Except an override of a generic base
// type's method ("InsertItem(System.Int32,Ns.Column)" for "InsertItem(System.Int32,`0)"), which also gets the tail of
// the method it overrides from the extractor. Kept off the entries, so not written.
const overloadKeys = new WeakMap<ApiMemberEntry, string>();
const overriddenKeys = new WeakMap<ApiMemberEntry, string>();
const overloadKey = (m: ApiMemberEntry) => overloadKeys.get(m) ?? m.name;
const methodKeys = (m: ApiMemberEntry) => [overloadKey(m), ...(overriddenKeys.has(m) ? [overriddenKeys.get(m)!] : [])];

// Members a type re-declares as [Obsolete] or hidden from IntelliSense ("property|Formula", "method|Clear()"): not
// listed as current, and the base type's version isn't inherited either (TemplateColumn hides Column.ValueConverter).
const redeclared = new WeakMap<ApiEntry, string[]>();

/**
 * Second pass: enrich every entry in-memory with inherited Infragistics members.
 * This walks the full base-type chain generically for ALL indexed types (properties,
 * events, and methods) — no per-component special-casing required. It also records
 * the immediate `baseType` on each entry so tools/descriptions can point callers to
 * the right base class dynamically instead of hardcoding examples.
 */
function enrichWithInheritance(
  entries: Map<string, ApiEntry>,
  baseTypes: Record<string, string>,
  allTypes: Map<string, ApiEntry>
): number {
  let enriched = 0;
  const fullKey = (e: ApiEntry) => `${e.assembly}|${e.dotnetNamespace}.${e.component}`;

  for (const entry of entries.values()) {
    const immediateBase = baseTypes[fullKey(entry)];
    if (!immediateBase) continue;
    entry.baseType = immediateBase.split('.').pop()!;

    const knownProps  = new Set(entry.properties.map(p => p.name));
    const knownEvents = new Set(entry.events.map(e => e.name));
    // By overload, not name: a type that declares one Export overload still inherits the base type's other ones.
    const knownMethods = new Set(entry.methods.flatMap(methodKeys));
    const knownObsolete = new Set((entry.obsolete ?? []).map(o => `${o.kind}|${o.signature ?? o.name}`));
    // A member re-declared [Obsolete] or hidden on a type hides every further base type's version of it.
    const block = (e: ApiEntry) => {
      for (const k of redeclared.get(e) ?? []) {
        const at = k.indexOf('|'), kind = k.slice(0, at), key = k.slice(at + 1);
        (kind === 'property' ? knownProps : kind === 'event' ? knownEvents : knownMethods).add(key);
      }
    };
    block(entry);
    const visited = new Set<string>([fullKey(entry)]);
    let added = false;
    let current = fullKey(entry);

    while (true) {
      const baseKey = baseTypes[current];
      if (!baseKey) break;
      if (visited.has(baseKey)) break;   // cycle guard
      visited.add(baseKey);

      // Looked up by full name among every parsed type, not just the pages: a base that lost its short name to a
      // same-named type (XamGrid's Cell; the "Cell" page documents the DataPresenter one) still passes its members on.
      const base = baseKey.split('.').pop()!;
      const baseEntry = allTypes.get(baseKey);
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
      for (const m of baseEntry.methods.filter(m => !m.declaredOn && !methodKeys(m).some(k => knownMethods.has(k)))) {
        const copy = { ...m, declaredOn: base };
        overloadKeys.set(copy, overloadKey(m));
        if (overriddenKeys.has(m)) overriddenKeys.set(copy, overriddenKeys.get(m)!);
        entry.methods.push(copy);
        for (const k of methodKeys(m)) knownMethods.add(k);
        added = true;
      }
      // Obsolete members are inherited too, so looking one up on a subtype still gets its replacement.
      for (const o of (baseEntry.obsolete ?? []).filter(o => !o.declaredOn && o.kind !== 'constructor' &&
                                                             !knownObsolete.has(`${o.kind}|${o.signature ?? o.name}`))) {
        if ((o.kind === 'property' && knownProps.has(o.name)) || (o.kind === 'event' && knownEvents.has(o.name))) continue;
        (entry.obsolete ??= []).push({ ...o, declaredOn: base });
        knownObsolete.add(`${o.kind}|${o.signature ?? o.name}`);
      }
      block(baseEntry);
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
  const { xaml: xamlTypes, baseTypes, nonPublic, nonPublicMembers, members: memberMeta, nonPublicMethods, memberTypes } = loadExtractorMaps();
  let skippedNonPublic = 0, skippedNonPublicMembers = 0, skippedObsolete = 0, skippedHidden = 0;
  const hiddenTypes: string[] = [];
  let methodsKept = 0, methodsSigned = 0;
  const unmatchedMethods: string[] = [];
  const uncoveredTypes: string[] = [];
  // Prefix per xmlns, for the few types the extractor has no entry for (generics, DLLs left out of XAML resolution).
  const prefixByXmlns = new Map(Object.values(xamlTypes).map(x => [x.xmlns, x.prefix]));
  const xamlFallbacks: string[] = [];
  const discovered = discoverXmlFiles();
  const sources = discovered.filter(s => !EXCLUDE_PACKAGES.includes(s.packageId.toLowerCase()));
  console.log(`Scanning ${sources.length} XML documentation files...`);

  const entries = new Map<string, ApiEntry>();
  // Every parsed type by "Assembly|Namespace.Type", including those that lose their short name below: the inheritance
  // walk follows real base types, which aren't always the type that owns their name.
  const allTypes = new Map<string, ApiEntry>();
  // Entries are keyed by short type name, but short names are not unique across
  // assemblies. Collisions are resolved case-INsensitively: type files are named after
  // the key, so on Windows "strings" and "Strings" would otherwise be written to the
  // same path concurrently and interleave into invalid JSON. loadApiDoc() also resolves
  // names case-insensitively, so a case-variant twin is unreachable regardless.
  const keyByLower = new Map<string, string>();
  const memberCounts = new Map<string, number>();
  const contestCounts = new Map<string, number>();
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
    type Bucket = { props: RawMember[]; fields: RawMember[]; events: RawMember[]; methods: RawMember[]; ctors: RawMember[] };
    const typeMembers = new Map<string, Bucket>();
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
      if (!typeMembers.has(typeFqn)) typeMembers.set(typeFqn, { props: [], fields: [], events: [], methods: [], ctors: [] });
      const bucket = typeMembers.get(typeFqn)!;
      if (m.kind === 'P') bucket.props.push(m);
      else if (m.kind === 'F') bucket.fields.push(m);   // kept below only if the extractor marked it isField
      else if (m.kind === 'E') bucket.events.push(m);
      else if (m.kind === 'M' && m.name === '#ctor') bucket.ctors.push(m);
      else if (m.kind === 'M' && !m.name.startsWith('#')) bucket.methods.push(m);   // not static constructors (#cctor)
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
      const bucket = typeMembers.get(type.fullName) ?? { props: [], fields: [], events: [], methods: [], ctors: [] };

      let xaml = xamlTypes[`${assemblyName}|${type.fullName}`];
      if (!xaml) {
        // No resolved entry (open generics can't be named in XAML; DLLs the extractor left out of XAML resolution):
        // clr-namespace syntax, which needs no xmlns mapping.
        const xmlns = `clr-namespace:${dotnetNs};assembly=${assemblyName}`;
        xaml = { xmlns, prefix: prefixByXmlns.get(xmlns) ?? `ig${dotnetNs.split('.').pop()}`, ns: dotnetNs };
        xamlFallbacks.push(type.fullName);
      }

      // Signature and flags by doc ID. For a type the extractor covered, every public / protected method and
      // constructor has an entry; a type it couldn't read keeps its members as the XML lists them, name-only.
      const covered = memberTypes.has(`${assemblyName}|${type.fullName}`);
      if (!covered) uncoveredTypes.push(type.fullName);
      const meta = (m: RawMember): MemberMeta | undefined => memberMeta[`${assemblyName}|${m.kind}:${m.fullName}`];

      const withTypeInfo = (m: RawMember) => {
        const ti = typeInfo[`${assemblyName}|${type.fullName}.${m.name}`];
        const extra = (ti && typeof ti === 'object') ? ti : {};
        const signature = meta(m)?.sig;   // indexers: "double this[int index]"
        return { name: m.name, summary: m.summary, ...extra, ...(signature ? { signature } : {}) };
      };
      // Operators read as C# ("operator ==", "implicit operator WorkbookColorInfo"), generic methods without the
      // doc ID's "``2" (the signature has the type parameters).
      const methodName = (m: RawMember) =>
        meta(m)?.sig?.match(/((?:implicit |explicit )?operator [^(]+)\(/)?.[1].trim() ?? m.name.replace(/``\d+$/, '');
      const withSignature = (m: RawMember, name: string): ApiMemberEntry => {
        const signature = meta(m)?.sig;
        // The XML docs sometimes describe a parameter that was renamed or removed ("func" for funct): left out.
        const real = signature ? new Set(meta(m)?.params ?? []) : undefined;
        const parameters = m.params?.filter(p => !real || real.has(p.name));
        const entry: ApiMemberEntry = {
          name, summary: m.summary, ...(signature ? { signature } : {}), ...(parameters?.length ? { parameters } : {}),
        };
        overloadKeys.set(entry, m.fullName.slice(type.fullName.length + 1));
        if (meta(m)?.overrides) overriddenKeys.set(entry, meta(m)!.overrides!);
        return entry;
      };
      // The XML docs also document members no app can call: internal / private ones (ValueEditor.InternalIsInitialized),
      // and explicit interface implementations, whose doc names have '#' for '.' ("System#Collections#IList#Add").
      const usable = (m: RawMember) => {
        if (m.summary.toLowerCase() === 'internal') return false;
        if ((m.name.includes('#') && m.name !== '#ctor') ||
            nonPublicMembers.has(`${assemblyName}|${type.fullName}.${m.name.replace(/``\d+$/, '')}`) ||
            // Checked per overload: one public Load overload doesn't make an internal one usable.
            (m.kind === 'M' && nonPublicMethods.has(`${assemblyName}|M:${m.fullName}`))) {
          skippedNonPublicMembers++;
          return false;
        }
        return true;
      };
      // [Obsolete] members go to their own list; members hidden from IntelliSense ("For internal use") are left out.
      const current = (m: RawMember) => {
        const flags = meta(m);
        if (flags?.obsolete !== undefined) { skippedObsolete++; return false; }
        if (flags?.hidden) { skippedHidden++; return false; }
        return true;
      };
      // Constructors: public ones that take parameters. A parameterless one goes without saying, and XAML needs it anyway.
      const isUsefulCtor = (m: RawMember) => m.fullName.includes('(') && !!meta(m)?.sig && !meta(m)!.sig!.startsWith('protected ');
      const ctorName = typeName.replace(/`\d+$/, '');   // "AverageResult", as the signature spells it
      const props = bucket.props.filter(usable);
      // Only the ResourceKey / RoutedCommand fields the extractor marked: the rest aren't used from XAML.
      const fields = bucket.fields.filter(usable).filter(m => (withTypeInfo(m) as ApiMemberEntry).isField === true);
      const events = bucket.events.filter(usable);
      const rawMethods = bucket.methods.filter(usable);
      const usableCtors = bucket.ctors.filter(usable);
      const rawCtors = usableCtors.filter(isUsefulCtor);

      const obsolete: ObsoleteMember[] = [
        ...[...props, ...fields].map(m => ({ m, kind: 'property' as const, name: m.name })),
        ...events.map(m => ({ m, kind: 'event' as const, name: m.name })),
        ...rawMethods.map(m => ({ m, kind: 'method' as const, name: methodName(m) })),
        ...rawCtors.map(m => ({ m, kind: 'constructor' as const, name: ctorName })),
      ].filter(({ m }) => meta(m)?.obsolete !== undefined).map(({ m, kind, name }) => ({
        name, kind, message: meta(m)!.obsolete!, ...(meta(m)!.sig ? { signature: meta(m)!.sig } : {}),
      }));
      const methods = rawMethods.filter(current).map(m => withSignature(m, methodName(m)));
      const constructors = rawCtors.filter(current).map(m => withSignature(m, ctorName));
      // A method or constructor of a type the extractor read that has neither a signature nor a non-public entry: the
      // doc ID it generated didn't match the XML's. Methods stay listed by name, and both count against the signature
      // gate below, so a mismatch fails the build instead of quietly dropping them.
      const unmatched = covered ? [...rawMethods, ...usableCtors].filter(m => !meta(m)) : [];
      unmatchedMethods.push(...unmatched.map(m => m.fullName));
      methodsKept += methods.length + constructors.length + unmatched.filter(m => m.name === '#ctor').length;
      methodsSigned += [...methods, ...constructors].filter(m => m.signature).length;

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
        properties: [...props, ...fields].filter(current).map(withTypeInfo),
        events:     events.filter(current).map(m => ({ name: m.name, summary: m.summary })),
        methods,
        ...(constructors.length ? { constructors } : {}),
        ...(obsolete.length ? { obsolete } : {}),
        // An [Obsolete] type keeps its page (old code and docs use UnboundField), which then leads with the replacement.
        ...(memberMeta[`${assemblyName}|T:${type.fullName}`]?.obsolete !== undefined
          ? { obsoleteMessage: memberMeta[`${assemblyName}|T:${type.fullName}`].obsolete } : {}),
      };
      const flagged = (m: RawMember) => meta(m)?.obsolete !== undefined || !!meta(m)?.hidden;
      const hiddenOrObsolete = [
        ...[...props, ...fields].filter(flagged).map(m => `property|${m.name}`),
        ...events.filter(flagged).map(m => `event|${m.name}`),
        ...rawMethods.filter(flagged).flatMap(m => [m.fullName.slice(type.fullName.length + 1), meta(m)?.overrides]
          .filter((k): k is string => !!k).map(k => `method|${k}`)),
      ];
      if (hiddenOrObsolete.length) redeclared.set(entry, hiddenOrObsolete);
      allTypes.set(`${assemblyName}|${type.fullName}`, entry);
      // A type hidden from IntelliSense (XamSparklineView, SeriesRenderManager) is public only for Infragistics' own
      // controls: no page and no list_wpf_components entry, but still a base its subtypes inherit members from.
      // An obsolete one keeps its page for the replacement note.
      const typeFlags = memberMeta[`${assemblyName}|T:${type.fullName}`];
      if (typeFlags?.hidden && typeFlags.obsolete === undefined) { hiddenTypes.push(type.fullName); continue; }

      const memberCount = entry.properties.length + entry.events.length + entry.methods.length;
      // Short-name contests are still decided by the count from before internal / private (and obsolete / hidden)
      // members were left out: with the new count, Cell, FieldChooser and RecordFilterCollection switched from the
      // DataPresenter types to the XamGrid / XamPivotGrid / DataManager ones.
      const documented = (ms: RawMember[]) => ms.filter(m => m.summary.toLowerCase() !== 'internal').length;
      const contestCount = documented(bucket.props) + fields.length + documented(bucket.events) + documented(bucket.methods);
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
        contestCounts.set(lower, contestCount);
      } else {
        // Two different types share this short name. Discovery order is just
        // package-alphabetical, which surfaces stub types over the real control
        // (e.g. a 20-member XamComboEditor beating the 125-member one), so keep
        // whichever documents more members and record the other as an alternate.
        const incumbent = entries.get(incumbentKey)!;
        if (!alternates.has(lower)) alternates.set(lower, []);

        if (contestCount > contestCounts.get(lower)!) {
          alternates.get(lower)!.push({
            fullName: `${incumbent.dotnetNamespace}.${incumbent.component}`,
            nugetPackage: incumbent.nugetPackage,
            memberCount: memberCounts.get(lower)!,
          });
          entries.delete(incumbentKey);
          entries.set(typeName, entry);
          keyByLower.set(lower, typeName);
          memberCounts.set(lower, memberCount);
          contestCounts.set(lower, contestCount);
        } else {
          alternates.get(lower)!.push(candidate);
        }
      }
    }    console.log(`${Date.now() - t0}ms  (${members.length} members)`);
  }

  console.log(`Left out ${skippedNonPublic} non-public (internal / private nested) type(s) documented in the XML, and ` +
    `${skippedNonPublicMembers} member(s) of public types that are internal / private or explicit interface implementations.`);
  console.log(`Left out ${hiddenTypes.length} type(s) hidden from IntelliSense (kept as base types): ${hiddenTypes.slice(0, 5).join(', ')}…`);
  console.log(`Members: ${skippedObsolete} [Obsolete] moved to "obsolete", ${skippedHidden} hidden from IntelliSense left out; ` +
    `${methodsSigned}/${methodsKept} methods and constructors have a signature (${uncoveredTypes.length} type(s) the extractor couldn't read` +
    `${uncoveredTypes.length ? `: ${uncoveredTypes.slice(0, 5).join(', ')}` : ''}).`);
  console.log(`${unmatchedMethods.length} method(s) / constructor(s) of types the extractor read matched none of its doc IDs` +
    `${unmatchedMethods.length ? ` (methods kept by name): ${unmatchedMethods.slice(0, 5).join(', ')}` : ''}.`);
  // Every method of a type the extractor read has a signature or a non-public entry, and the rest count as unsigned,
  // so a low share means the doc IDs it generated stopped matching the XML's: agents would be back to method names
  // without parameters.
  assertBuildStep(methodsKept > 0 && methodsSigned / methodsKept >= 0.95,
    `Only ${methodsSigned} of ${methodsKept} methods and constructors got a signature from nuget/type-info.json "__members". ` +
    `The extractor's doc IDs (MethodDocId / ParamId in scripts/type-extractor/Program.cs) no longer match the XML docs' ` +
    `<member name="M:…"> IDs, or type-info.json is stale. Run: npm run generate:types`
  );
  const genericFallbacks = xamlFallbacks.filter(n => n.includes('`')).length;
  console.log(`XAML namespaces: ${xamlFallbacks.length} type(s) fell back to clr-namespace syntax ` +
    `(${genericFallbacks} generic, ${xamlFallbacks.length - genericFallbacks} other${xamlFallbacks.length > genericFallbacks ? `: ${xamlFallbacks.filter(n => !n.includes('`')).slice(0, 8).join(', ')}` : ''})`);

  for (const [lower, alts] of alternates) {
    const winner = entries.get(keyByLower.get(lower)!);
    if (winner) winner.alternates = alts.sort((a, b) => b.memberCount - a.memberCount);
  }

  // Enrich in-memory, then write everything at once
  console.log(`Enriching inheritance...`);
  const enriched = enrichWithInheritance(entries, baseTypes, allTypes);

  const escaped = [...entries.values()].filter(e => /\\\\u00[0-9A-Fa-f]{2}/.test(JSON.stringify(e)));
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
    // Overloads share a name, listed once. Obsolete names stay searchable: old code and docs still use them, and the
    // type's page answers a lookup with the replacement.
    m: [...new Set([
      ...e.properties.map(x => x.name),
      ...e.events.map(x => x.name),
      ...e.methods.map(x => x.name),
      ...(e.obsolete ?? []).filter(o => o.kind !== 'constructor').map(o => o.name),
    ])],
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
