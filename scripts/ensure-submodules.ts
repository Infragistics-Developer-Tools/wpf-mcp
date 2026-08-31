#!/usr/bin/env tsx
/**
 * ensure-submodules.ts
 *
 * docs/docs-wpf, docs/docs-common, docs/wpf-resources are git submodules. A plain
 * `git clone` (no --recurse-submodules) leaves their folders present but EMPTY.
 * That used to fail silently and inconsistently: build-docs.ts only warned and wrote
 * an empty docs-index.json (search_wpf_docs then "works" but finds nothing, forever),
 * while build-themes.ts hard-exited but only after the docs step had already "succeeded".
 * This script auto-heals with the standard init command, then hard-fails loudly if
 * that didn't actually populate real content — no silent partial/empty data ever again.
 *
 * Called automatically by build-docs.ts and build-themes.ts. Also runnable standalone:
 *   npx tsx scripts/ensure-submodules.ts
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assertBuildStep } from './build-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// One real, always-present file/folder per submodule — proves it's actually checked
// out, not just a registered-but-empty path (which is what an uninitialized submodule
// looks like on disk).
const SUBMODULES = [
  { name: 'docs/docs-wpf',      marker: join(ROOT, 'docs', 'docs-wpf', 'topics', 'en') },
  { name: 'docs/docs-common',   marker: join(ROOT, 'docs', 'docs-common', 'DocsConfig.xml') },
  { name: 'docs/wpf-resources', marker: join(ROOT, 'docs', 'wpf-resources', 'Themes') },
];

function missingSubmodules(): string[] {
  return SUBMODULES.filter(s => !existsSync(s.marker)).map(s => s.name);
}

export function ensureSubmodules(): void {
  let missing = missingSubmodules();
  if (missing.length === 0) return;

  console.warn(`\n⚠  Submodule(s) not initialized: ${missing.join(', ')}\n   Running: git submodule update --init --recursive\n`);
  try {
    execFileSync('git', ['submodule', 'update', '--init', '--recursive'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    // Ignore — the assertion below reports the real failure with actionable instructions either way.
  }

  missing = missingSubmodules();
  assertBuildStep(missing.length === 0,
    `Required submodule(s) still missing: ${missing.join(', ')}\n\n` +
    `This is fatal, not optional: without them the docs/theme index would silently build EMPTY,\n` +
    `and every search_wpf_docs / setup_wpf_theme / get_wpf_theme_resource / get_wpf_theme_palette\n` +
    `call would return "not found" forever with no indication why.\n\n` +
    `Fix manually (network access to GitHub required), then re-run your build command:\n` +
    `  git submodule update --init --recursive`
  );
}

const isMain = process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureSubmodules();
  console.log('✅  All submodules present.');
}
