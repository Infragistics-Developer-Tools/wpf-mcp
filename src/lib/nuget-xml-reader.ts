import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface ApiMember {
  name: string;
  kind: 'property' | 'method' | 'event' | 'field';
  summary: string;
}

export interface ComponentApiDoc {
  component: string;
  fullTypeName: string;
  summary: string;
  remarks: string;
  members: ApiMember[];
}

// ── Path resolution ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const TFM_PREFERENCE = ['net8.0-windows7.0', 'net10.0-windows7.0', 'net9.0-windows7.0', 'net40'];

const PACKAGES_ROOT = join(__dirname, '../../nuget/packages');

export function findNuGetXmlPath(packageId: string, assemblyName: string): string | null {
  const packageDir = join(PACKAGES_ROOT, packageId.toLowerCase());
  if (!existsSync(packageDir)) return null;

  const versions = readdirSync(packageDir).sort().reverse();
  for (const version of versions) {
    for (const tfm of TFM_PREFERENCE) {
      const xmlPath = join(packageDir, version, 'lib', tfm, `${assemblyName}.xml`);
      if (existsSync(xmlPath)) return xmlPath;
    }
  }
  return null;
}

// ── XML parsing ──────────────────────────────────────────────────────────────

/** Strip XML tags from a string and normalise whitespace. */
function stripXml(text: string): string {
  return text
    .replace(/<see\s+cref="[TPMFEtpmfe]:([^"]+)"\s*\/>/g, (_, ref) => {
      // "T:Infragistics.Windows.DataPresenter.XamDataGrid" → "XamDataGrid"
      const parts = ref.split('.');
      return parts[parts.length - 1];
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract text content of the first occurrence of <tagName>...</tagName>. */
function extractTag(xml: string, tagName: string): string {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const start = xml.indexOf(open);
  if (start === -1) return '';
  const end = xml.indexOf(close, start);
  if (end === -1) return '';
  return stripXml(xml.slice(start + open.length, end));
}

/** Extract the text inside <summary> of a <member> block. */
function extractSummary(memberXml: string): string {
  return extractTag(memberXml, 'summary');
}

/** Extract <remarks> text. */
function extractRemarks(memberXml: string): string {
  return extractTag(memberXml, 'remarks');
}

/** Split raw XML into individual <member>…</member> blocks. */
function splitMembers(xml: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  const re = /<member\s+name="([^"]+)">([\s\S]*?)<\/member>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push({ name: m[1], body: m[2] });
  }
  return results;
}

/** Infer member kind from the MemberInfo prefix (T/P/M/E/F). */
function memberKind(prefix: string): ApiMember['kind'] {
  switch (prefix) {
    case 'P': return 'property';
    case 'M': return 'method';
    case 'E': return 'event';
    default:  return 'field';
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse API documentation for a single type from a NuGet XML doc file.
 *
 * @param xmlPath   Full path to the .xml file (e.g. Infragistics.WPF.DataPresenter.xml)
 * @param fullType  Fully-qualified type name (e.g. "Infragistics.Windows.DataPresenter.XamDataGrid")
 * @param componentName  Short display name (e.g. "XamDataGrid")
 */
export function parseComponentFromXml(
  xmlPath: string,
  fullType: string,
  componentName: string
): ComponentApiDoc | null {
  if (!existsSync(xmlPath)) return null;

  const xml = readFileSync(xmlPath, 'utf-8');
  const allMembers = splitMembers(xml);

  // Find the type entry
  const typeEntry = allMembers.find(m => m.name === `T:${fullType}`);
  const summary = typeEntry ? extractSummary(typeEntry.body) : '';
  const remarks = typeEntry ? extractRemarks(typeEntry.body) : '';

  // Collect all P:/M:/E: entries directly on this type (not inherited)
  const prefix = `${fullType}.`;
  const members: ApiMember[] = [];

  for (const m of allMembers) {
    const kindChar = m.name[0];
    if (!['P', 'M', 'E'].includes(kindChar)) continue;
    if (!m.name.startsWith(`${kindChar}:${prefix}`)) continue;

    // Strip the type prefix to get just the member name (and strip method params)
    const raw = m.name.slice(kindChar.length + 1 + prefix.length);
    const name = raw.replace(/\(.*$/, ''); // drop method parameters

    // Skip compiler-generated / trivial members
    if (name.startsWith('get_') || name.startsWith('set_') || name.startsWith('.')) continue;

    members.push({
      name,
      kind: memberKind(kindChar),
      summary: extractSummary(m.body),
    });
  }

  return { component: componentName, fullTypeName: fullType, summary, remarks, members };
}
