#!/usr/bin/env tsx
/**
 * build-info.ts
 *
 * Writes src/data/build-info.json — the only record of what data a published
 * package was built from, since none of src/data/ is committed:
 *   infragisticsVersion   from nuget/WpfDocs.csproj
 *   packageVersion        from package.json
 *   submodules            commit SHA of each docs/theme submodule
 *   builtAt               ISO timestamp
 *
 * Runs last in `npm run build:data`; the server prints it to stderr on startup
 * and validate-package.ts cross-checks it against the csproj.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assertBuildStep } from './build-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dirname, '..');
const OUT_DIR  = join(ROOT, 'src', 'data');
const OUT_FILE = join(OUT_DIR, 'build-info.json');

export const SUBMODULES = ['docs/docs-wpf', 'docs/docs-common', 'docs/wpf-resources'];

export function readInfragisticsVersion(): string {
  const csproj = readFileSync(join(ROOT, 'nuget', 'WpfDocs.csproj'), 'utf-8');
  const versions = new Set([...csproj.matchAll(/<PackageReference\s[^>]*Version="([^"]+)"/g)].map(m => m[1]));
  assertBuildStep(versions.size === 1,
    `Expected exactly one Infragistics package version in nuget/WpfDocs.csproj, found: ` +
    `${[...versions].join(', ') || '(none)'}`);
  return [...versions][0];
}

function submoduleSha(path: string): string {
  return execFileSync('git', ['-C', join(ROOT, path), 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

const isMain = process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { version: packageVersion } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const info = {
    packageVersion,
    infragisticsVersion: readInfragisticsVersion(),
    submodules: Object.fromEntries(SUBMODULES.map(s => [s, submoduleSha(s)])),
    builtAt: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(info, null, 2) + '\n', 'utf-8');
  console.log(`Build info → src/data/build-info.json`);
  console.log(`  Infragistics ${info.infragisticsVersion}, package ${info.packageVersion}`);
  for (const [name, sha] of Object.entries(info.submodules)) console.log(`  ${name} @ ${sha.slice(0, 12)}`);
}
