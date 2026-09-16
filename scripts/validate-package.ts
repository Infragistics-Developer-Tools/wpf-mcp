#!/usr/bin/env tsx
/**
 * validate-package.ts
 *
 * Pre-publish gate: proves that dist/ contains a complete, non-degraded data set and
 * that the version about to be published is consistent everywhere.
 *
 *   npx tsx scripts/validate-package.ts [--expected-version 1.2.3]
 *
 * --expected-version (or EXPECTED_VERSION) is the release tag; when given, package.json
 * and server.json must all agree with it. Thresholds are deliberately below the real
 * counts (see README) so a version bump never trips them, but a partial build does.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readInfragisticsVersion } from './build-info.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dirname, '..');
const DIST     = join(ROOT, 'dist');
const DATA     = join(DIST, 'data');

const MIN_COMPONENTS      = 150;
const MIN_SEARCH_ENTRIES  = 5000;
const MIN_SEARCH_BYTES    = 2 * 1024 * 1024;
const MIN_API_FILES       = 6000;
const MIN_DOC_TOPICS      = 2000;
const MIN_NEWER_THEMES    = 5;
const MIN_LEGACY_FOLDERS  = 20;
const MIN_THEME_XAML      = 100;

const errors: string[] = [];

function getExpectedVersion(): string | null {
  const idx = process.argv.indexOf('--expected-version');
  if (idx >= 0) {
    const value = process.argv[idx + 1]?.trim();
    if (!value || value.startsWith('--')) {
      console.error('Missing or invalid value for "--expected-version". Provide a version after the flag.');
      process.exit(1);
    }
    return value.replace(/^v/, '');
  }
  if (process.env.EXPECTED_VERSION) return process.env.EXPECTED_VERSION.replace(/^v/, '');
  return null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function ok(kind: string, detail: string, what: string): void {
  console.log(`OK  ${kind.padEnd(4)} ${detail.padStart(10)}  ${what}`);
}

function readJson<T>(rel: string): T | null {
  const full = join(DATA, rel);
  if (!existsSync(full)) { errors.push(`missing: dist/data/${rel}`); return null; }
  try { return JSON.parse(readFileSync(full, 'utf-8')) as T; }
  catch (e) { errors.push(`unparseable: dist/data/${rel} (${(e as Error).message})`); return null; }
}

function countFiles(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name), ext);
    else if (entry.name.endsWith(ext)) n++;
  }
  return n;
}

// ── Version consistency ───────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const expectedVersion = getExpectedVersion();
if (expectedVersion) {
  if (pkg.version !== expectedVersion) {
    errors.push(`package.json version mismatch: got ${pkg.version}, expected ${expectedVersion}`);
  } else {
    ok('ver', pkg.version, 'package.json');
  }

  const serverJsonPath = join(ROOT, 'server.json');
  if (!existsSync(serverJsonPath)) {
    errors.push(`server.json missing: ${serverJsonPath}`);
  } else {
    const serverJson = JSON.parse(readFileSync(serverJsonPath, 'utf-8'));
    if (serverJson.version !== expectedVersion) {
      errors.push(`server.json version mismatch: got ${serverJson.version}, expected ${expectedVersion}`);
    } else {
      ok('ver', serverJson.version, 'server.json');
    }
    const pkgs: Array<{ identifier?: string; version?: string }> = serverJson.packages ?? [];
    if (pkgs.length === 0) errors.push('server.json has no entries in "packages"');
    pkgs.forEach((p, i) => {
      const label = p.identifier ?? `packages[${i}]`;
      if (p.version !== expectedVersion) {
        errors.push(`server.json ${label} version mismatch: got ${p.version}, expected ${expectedVersion}`);
      } else {
        ok('ver', p.version ?? '', `server.json ${label}`);
      }
      if (p.identifier !== pkg.name) {
        errors.push(`server.json ${label} does not match package.json name ${pkg.name}`);
      }
    });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const entry = join(DIST, 'index.js');
if (!existsSync(entry)) {
  errors.push(`missing: dist/index.js — run npm run build`);
} else if (!readFileSync(entry, 'utf-8').startsWith('#!/usr/bin/env node')) {
  errors.push('dist/index.js has no "#!/usr/bin/env node" shebang — the bin entry would not be executable');
} else {
  ok('bin', formatSize(statSync(entry).size), 'dist/index.js');
}

// ── Data set ──────────────────────────────────────────────────────────────────

const components = readJson<Array<{ component: string; xamlNamespace: string; nugetPackage: string }>>('namespaces.json');
if (components) {
  if (components.length < MIN_COMPONENTS) {
    errors.push(`namespaces.json has ${components.length} components < ${MIN_COMPONENTS}`);
  } else if (components.some(c => !c.component || !c.xamlNamespace || !c.nugetPackage)) {
    errors.push('namespaces.json has entries missing component/xamlNamespace/nugetPackage');
  } else {
    ok('data', String(components.length), 'components in namespaces.json');
  }
}

const searchPath = join(DATA, 'search-index.json');
const search = readJson<unknown[]>('search-index.json');
if (search) {
  const size = statSync(searchPath).size;
  if (search.length < MIN_SEARCH_ENTRIES) {
    errors.push(`search-index.json has ${search.length} entries < ${MIN_SEARCH_ENTRIES}`);
  } else if (size < MIN_SEARCH_BYTES) {
    errors.push(`search-index.json is ${formatSize(size)} < ${formatSize(MIN_SEARCH_BYTES)}`);
  } else {
    ok('data', String(search.length), `types in search-index.json (${formatSize(size)})`);
  }
}

const apiFiles = countFiles(join(DATA, 'api'), '.json');
if (apiFiles < MIN_API_FILES) {
  errors.push(`dist/data/api has ${apiFiles} type files < ${MIN_API_FILES}`);
} else {
  ok('data', String(apiFiles), 'type files in api/');
}
const dataGrid = readJson<{ properties: unknown[] }>('api/XamDataGrid.json');
if (dataGrid && dataGrid.properties.length < 50) {
  errors.push(`api/XamDataGrid.json has ${dataGrid.properties.length} properties — inheritance enrichment did not run`);
}

const docs = readJson<unknown[]>('docs-index.json');
if (docs) {
  const docFiles = countFiles(join(DATA, 'docs'), '.json');
  if (docs.length < MIN_DOC_TOPICS) {
    errors.push(`docs-index.json has ${docs.length} topics < ${MIN_DOC_TOPICS}`);
  } else if (docFiles !== docs.length) {
    errors.push(`docs-index.json lists ${docs.length} topics but dist/data/docs has ${docFiles} files`);
  } else {
    ok('data', String(docs.length), 'topics in docs-index.json');
  }
}

const themes = readJson<{ newerThemes: unknown[]; legacyStyles: unknown[] }>('theme-index.json');
if (themes) {
  const xaml = countFiles(join(DATA, 'theme-resources'), '.xaml');
  if (themes.newerThemes.length < MIN_NEWER_THEMES) {
    errors.push(`theme-index.json has ${themes.newerThemes.length} newer themes < ${MIN_NEWER_THEMES}`);
  } else if (themes.legacyStyles.length < MIN_LEGACY_FOLDERS) {
    errors.push(`theme-index.json has ${themes.legacyStyles.length} legacy style folders < ${MIN_LEGACY_FOLDERS}`);
  } else if (xaml < MIN_THEME_XAML) {
    errors.push(`dist/data/theme-resources has ${xaml} .xaml files < ${MIN_THEME_XAML}`);
  } else {
    ok('data', `${themes.newerThemes.length}/${themes.legacyStyles.length}`, `newer themes / legacy folders (${xaml} xaml files)`);
  }
}

const info = readJson<{ infragisticsVersion: string; packageVersion: string; builtAt: string }>('build-info.json');
if (info) {
  const csprojVersion = readInfragisticsVersion();
  if (info.infragisticsVersion !== csprojVersion) {
    errors.push(`build-info.json says Infragistics ${info.infragisticsVersion} but nuget/WpfDocs.csproj pins ${csprojVersion} — data is stale, rerun npm run build:data`);
  } else if (info.packageVersion !== pkg.version) {
    errors.push(`build-info.json was built for package ${info.packageVersion} but package.json is ${pkg.version} — rerun npm run build:info && npm run build`);
  } else {
    ok('info', info.infragisticsVersion, `Infragistics version (built ${info.builtAt})`);
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`\nValidation failed with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
