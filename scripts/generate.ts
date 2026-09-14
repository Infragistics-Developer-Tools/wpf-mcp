#!/usr/bin/env tsx
/**
 * generate.ts
 *
 * Runs the C# type extractor (→ nuget/type-info.json) and then build-api.ts.
 *
 * The extractor is the slowest step after the NuGet restore, and its output depends
 * only on the restored packages and its own source. So it is skipped when
 * nuget/type-info.json is newer than both nuget/WpfDocs.csproj and every file in
 * scripts/type-extractor/ — which is exactly the state CI is in after a cache hit.
 * Pass --force to run it regardless.
 *
 * Prerequisite: nuget/packages/ populated (npm run docs:restore).
 */

import { execSync } from 'child_process';
import { existsSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT          = join(__dirname, '..');
const TYPE_INFO     = join(ROOT, 'nuget', 'type-info.json');
const CSPROJ        = join(ROOT, 'nuget', 'WpfDocs.csproj');
const EXTRACTOR_DIR = join(__dirname, 'type-extractor');

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'bin' || entry.name === 'obj') continue;
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function typeInfoIsFresh(): boolean {
  if (!existsSync(TYPE_INFO)) return false;
  const built = statSync(TYPE_INFO).mtimeMs;
  return built > statSync(CSPROJ).mtimeMs && built > newestMtime(EXTRACTOR_DIR);
}

const force = process.argv.includes('--force');

if (!force && typeInfoIsFresh()) {
  console.log('nuget/type-info.json is up to date — skipping type extractor (pass --force to rerun).');
} else {
  execSync('npm run generate:types', { cwd: ROOT, stdio: 'inherit' });
}

execSync('npx tsx scripts/build-api.ts', { cwd: ROOT, stdio: 'inherit' });
