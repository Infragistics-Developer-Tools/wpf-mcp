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
 *     Per-theme resource dictionaries applied at runtime via Infragistics.Themes.ThemeManager
 *     (ApplicationTheme = new MetroDarkTheme()), not embedded in the component assemblies:
 *     the "Infragistics.Controls.*" controls (charts, gauges, etc.) and most "Infragistics.Windows.*"
 *     ones too (XamDataGrid, the xamEditors, XamDockManager, XamRibbon, ...). One folder per named
 *     theme (MetroDark, RoyalDark, Office2013, ...), containing both per-control files
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
 *   nuget/type-info.json "__themeMappings" (the type extractor, from the theme DLLs)
 *     Which controls each ThemeManager theme styles, and with which of its files. Many of those
 *     files name no TargetType for the control (RoyalDark.xamDataPresenter.xaml only merges
 *     <igThemes:DataPresenterRoyalDark />), so without it XamDataGrid looked legacy-only.
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
import { ensureSubmodules } from './ensure-submodules.js';
import { assertBuildStep } from './build-guard.js';

ensureSubmodules();

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
  targetTypes: string[]; // distinct control type names this file styles: parsed from TargetType="...", plus for Themes/ files the controls the theme's ThemeManager maps to it
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

// Matches both `TargetType="local:XamCategoryChart"` and `TargetType="{x:Type local:XamXYChart}"`
// (with or without a namespace prefix before the colon), capturing just the type name.
// Some theme files bundle Style blocks for an entire control family (e.g. "MetroDark.xamDataChart.xaml"
// styles XamDataChart, XamCategoryChart, XamPieChart, XamFunnelChart, ... all in one file) under a
// file name that only matches ONE of those types — this lets lookups match on what's genuinely
// styled inside the file instead of only the file's own name.
const TARGET_TYPE_RE = /TargetType\s*=\s*"\{?(?:x:Type\s+)?(?:[\w.]+:)?([\w`]+)\}?"/g;

function extractTargetTypes(content: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  TARGET_TYPE_RE.lastIndex = 0;
  while ((m = TARGET_TYPE_RE.exec(content))) {
    found.add(m[1]);
  }
  return [...found].sort();
}

function toResourceFiles(srcDir: string, prefix: string, files: string[]): ThemeResourceFile[] {
  return files.map(f => ({
    path: `${prefix}/${f}`,
    file: f,
    targetTypes: extractTargetTypes(readFileSync(join(srcDir, f), 'utf-8')),
  }));
}

// ── Newer ThemeManager themes ─────────────────────────────────────────────────

// Theme name → { control full name → file name }, from the theme DLLs (see "Phase 4" in type-extractor/Program.cs).
const TYPE_INFO = join(ROOT, 'nuget', 'type-info.json');
assertBuildStep(existsSync(TYPE_INFO),
  `nuget/type-info.json not found. Without its "__themeMappings", setup_wpf_theme would show XamDataGrid, the ` +
  `xamEditors, XamTreeGrid, ... as legacy-only (Theme="..."), though ThemeManager.ApplicationTheme styles them. ` +
  `Run: npm run generate:types`
);
const themeMappings = JSON.parse(readFileSync(TYPE_INFO, 'utf-8')).__themeMappings as Record<string, Record<string, string>> | undefined;
assertBuildStep(!!themeMappings && Object.keys(themeMappings).length > 0,
  `nuget/type-info.json has no "__themeMappings" section — it was written by an older type extractor. Run: npm run generate:types`
);

const newerThemes: NewerThemeEntry[] = [];
const unmatched: string[] = [];
let mapped = 0;
for (const themeName of listSubdirs(THEMES_SRC)) {
  const srcDir = join(THEMES_SRC, themeName);
  const files = listXamlFiles(srcDir);
  if (!files.length) continue;
  copyXaml(srcDir, join(OUT_RESOURCES_DIR, 'Themes', themeName), files);
  const entry = { theme: themeName, files: toResourceFiles(srcDir, `Themes/${themeName}`, files) };
  // The DLL names the files with other casing ("Themes\RoyalDark.XamDataPresenter.xaml", "Ig.xamBarcode.xaml").
  const themeKey = Object.keys(themeMappings!).find(k => k.toLowerCase() === themeName.toLowerCase());
  for (const [control, fileName] of Object.entries(themeKey ? themeMappings![themeKey] : {})) {
    const file = entry.files.find(f => f.file.toLowerCase() === fileName.toLowerCase());
    if (!file) { unmatched.push(`${themeName}: ${control} → ${fileName}`); continue; }
    const name = control.split(/[.+]/).pop()!;
    if (!file.targetTypes.includes(name)) file.targetTypes = [...file.targetTypes, name].sort();
    mapped++;
  }
  newerThemes.push(entry);
}
const missingThemes = Object.keys(themeMappings!).filter(k => !newerThemes.some(t => t.theme.toLowerCase() === k.toLowerCase()));
assertBuildStep(unmatched.length === 0 && missingThemes.length === 0,
  `The theme DLLs map controls to ${unmatched.length} file(s) and ${missingThemes.length} theme(s) that ` +
  `docs/wpf-resources/Themes/ doesn't have (${[...missingThemes, ...unmatched].slice(0, 5).join('; ')}) — the submodule ` +
  `and the NuGet theme packages are out of step. Bump them together.`
);

// ── Legacy "Infragistics.Windows.*" per-component embedded themes ────────────

const legacyStyles: LegacyStyleEntry[] = [];
for (const folder of listSubdirs(DEFAULT_STYLES_SRC)) {
  const srcDir = join(DEFAULT_STYLES_SRC, folder);
  const files = listXamlFiles(srcDir);
  if (!files.length) continue;
  copyXaml(srcDir, join(OUT_RESOURCES_DIR, 'DefaultStyles', folder), files);
  legacyStyles.push({ folder, files: toResourceFiles(srcDir, `DefaultStyles/${folder}`, files) });
}

mkdirSync(OUT_DATA_DIR, { recursive: true });
writeFileSync(INDEX_FILE, JSON.stringify({ newerThemes, legacyStyles } satisfies ThemeIndex, null, 2));

const totalFiles = newerThemes.reduce((n, t) => n + t.files.length, 0) + legacyStyles.reduce((n, s) => n + s.files.length, 0);

assertBuildStep(totalFiles > 0,
  `Submodule docs/wpf-resources is present, but 0 theme/style XAML files were found under ` +
  `Themes/ or DefaultStyles/. This means the submodule is populated but its folder layout no ` +
  `longer matches what this script expects — a data-shape drift, not a missing dependency. ` +
  `Needs a code fix in build-themes.ts, not a submodule re-init.`
);

console.log(`theme-index.json: ${newerThemes.length} newer themes, ${legacyStyles.length} legacy style folders, ${totalFiles} XAML files total; ` +
  `${mapped} ThemeManager control → file mappings applied.`);
