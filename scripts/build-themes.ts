#!/usr/bin/env tsx
/**
 * build-themes.ts
 *
 * Processes the raw theme/style XAML resource dictionaries from the wpf-resources
 * submodule and produces:
 *   src/data/theme-index.json                 lightweight index (loaded at startup)
 *   src/data/theme-resources/{Themes,DefaultStyles}/...   raw .xaml files (read on demand)
 *
 * Sources (docs/wpf-resources submodule — https://github.com/Infragistics/wpf-resources):
 *   Themes/{ThemeName}/*.xaml
 *     Per-theme resource dictionaries for the newer "Infragistics.Controls.*" family
 *     (charts, gauges, etc.) — applied at runtime via Infragistics.Themes.ThemeManager,
 *     not embedded in the component assemblies. One folder per named theme
 *     (MetroDark, RoyalDark, Office2013, ...), containing both per-control files
 *     (e.g. "MetroDark.xamDataChart.xaml") and shared/core files (e.g.
 *     "MetroDark.WPF.xaml", "MetroDark.Theme.Colors.xaml").
 *
 *   DefaultStyles/{ComponentFolder}/*.xaml
 *     Per-component style/template resource dictionaries for the older
 *     "Infragistics.Windows.*" family (XamDataGrid, XamRibbon, XamDockManager, ...).
 *     These themes ship embedded as BAML inside the component's own assembly and are
 *     applied just by setting `Theme="MetroDark"` on the control — no merging needed
 *     for the out-of-the-box look. The raw XAML here is useful for *customizing*:
 *     copy the relevant Style/ControlTemplate and override just the parts you need.
 *
 * Deliberately excluded: Dictionaries/ (spell-check word lists) and ResourceStrings/
 * (localization .resx) — not relevant to visual theming. Only *.xaml files are copied
 * (binary .cur cursor files and Images/ subfolders are skipped).
 *
 * Run:  npx tsx scripts/build-themes.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT                = join(__dirname, '..');
const RESOURCES_DIR       = join(ROOT, 'docs', 'wpf-resources');
const THEMES_SRC          = join(RESOURCES_DIR, 'Themes');
const DEFAULT_STYLES_SRC  = join(RESOURCES_DIR, 'DefaultStyles');
const OUT_DATA_DIR        = join(ROOT, 'src', 'data');
const OUT_RESOURCES_DIR   = join(OUT_DATA_DIR, 'theme-resources');
const INDEX_FILE          = join(OUT_DATA_DIR, 'theme-index.json');

// ── Types ─────────────────────────────────────────────────────────────────────

interface ThemeResourceFile {
  path: string; // relative path used as the get_wpf_theme_resource `path` input, e.g. "Themes/MetroDark/MetroDark.xamDataChart.xaml"
  file: string; // filename only, e.g. "MetroDark.xamDataChart.xaml"
}

interface NewerThemeEntry {
  theme: string; // e.g. "MetroDark"
  files: ThemeResourceFile[];
}

interface LegacyStyleEntry {
  folder: string; // e.g. "Ribbon"
  files: ThemeResourceFile[];
}

export interface ThemeIndex {
  newerThemes: NewerThemeEntry[];
  legacyStyles: LegacyStyleEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => statSync(join(dir, f)).isDirectory()).sort();
}

function listXamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => statSync(join(dir, f)).isFile() && f.toLowerCase().endsWith('.xaml'))
    // Keep only real resource dictionaries — skip stray docs like Ribbon/Readme.xaml,
    // which is a <Window> sample, not a theme resource.
    .filter(f => readFileSync(join(dir, f), 'utf-8').includes('ResourceDictionary'))
    .sort();
}

function copyXaml(srcDir: string, destDir: string, files: string[]): void {
  mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(destDir, f), readFileSync(join(srcDir, f)));
  }
}

if (!existsSync(RESOURCES_DIR)) {
  console.error(`wpf-resources submodule not found at ${RESOURCES_DIR}. Run: git submodule update --init docs/wpf-resources`);
  process.exit(1);
}

// ── Newer "Infragistics.Controls.*" ThemeManager themes ──────────────────────

const newerThemes: NewerThemeEntry[] = [];
for (const themeName of listSubdirs(THEMES_SRC)) {
  const srcDir = join(THEMES_SRC, themeName);
  const files = listXamlFiles(srcDir);
  if (!files.length) continue;
  copyXaml(srcDir, join(OUT_RESOURCES_DIR, 'Themes', themeName), files);
  newerThemes.push({ theme: themeName, files: files.map(f => ({ path: `Themes/${themeName}/${f}`, file: f })) });
}

// ── Legacy "Infragistics.Windows.*" per-component embedded themes ────────────

const legacyStyles: LegacyStyleEntry[] = [];
for (const folder of listSubdirs(DEFAULT_STYLES_SRC)) {
  const srcDir = join(DEFAULT_STYLES_SRC, folder);
  const files = listXamlFiles(srcDir);
  if (!files.length) continue;
  copyXaml(srcDir, join(OUT_RESOURCES_DIR, 'DefaultStyles', folder), files);
  legacyStyles.push({ folder, files: files.map(f => ({ path: `DefaultStyles/${folder}/${f}`, file: f })) });
}

mkdirSync(OUT_DATA_DIR, { recursive: true });
writeFileSync(INDEX_FILE, JSON.stringify({ newerThemes, legacyStyles } satisfies ThemeIndex, null, 2));

const totalFiles = newerThemes.reduce((n, t) => n + t.files.length, 0) + legacyStyles.reduce((n, s) => n + s.files.length, 0);
console.log(`theme-index.json: ${newerThemes.length} newer themes, ${legacyStyles.length} legacy style folders, ${totalFiles} XAML files total.`);
