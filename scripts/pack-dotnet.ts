#!/usr/bin/env tsx
/**
 * pack-dotnet.ts — builds the NuGet package for the C# server into nupkg/.
 *
 *   npx tsx scripts/pack-dotnet.ts [--version 1.2.3]
 *
 * The version defaults to package.json's so a local pack matches what a release would
 * produce; the publish workflow passes the release tag explicitly. The csproj itself
 * carries no version (0.0.0-dev) — package.json is the single source, like server.json.
 * Requires src/data/ (the csproj copies it into the package).
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dirname, '..');
const CSPROJ  = join(ROOT, 'server', 'Infragistics.Wpf.Mcp.csproj');
const OUT_DIR = join(ROOT, 'nupkg');

// --version "" (CI without a release tag) falls back to package.json like an omitted flag.
const idx = process.argv.indexOf('--version');
const arg = idx >= 0 ? process.argv[idx + 1] : '';
if (arg === undefined || arg.startsWith('--')) {
  console.error('Missing value for --version.');
  process.exit(1);
}
const version = arg.replace(/^v/, '')
  || (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

if (!existsSync(join(ROOT, 'src', 'data', 'namespaces.json'))) {
  console.error('src/data/ is missing — run npm run build:data first.');
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
execFileSync('dotnet', ['pack', CSPROJ, '-c', 'Release', `-p:Version=${version}`, '-o', OUT_DIR, '-nologo', '-v', 'q'], {
  cwd: ROOT,
  stdio: 'inherit',
});

const nupkg = readdirSync(OUT_DIR).find(f => f.endsWith('.nupkg'));
if (!nupkg) {
  console.error('dotnet pack produced no .nupkg');
  process.exit(1);
}
console.log(`nupkg/${nupkg}`);
