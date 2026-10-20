#!/usr/bin/env tsx
/**
 * smoke-test.ts
 *
 * Starts the built server (dist/index.js) over stdio exactly as an MCP client would,
 * then exercises every tool once against the real data set. This is the `npm test`
 * gate for CI and publishing: a build whose data is present but wrong (empty index,
 * missing inheritance, broken path guard) passes validate-package's counts but not this.
 *
 * Prerequisite: npm run build (dist/ must exist). Pass --dotnet (npm run test:dotnet) to run the
 * same checks against the C# server (dotnet build server/ first; WPF_MCP_DOTNET_DLL overrides the path).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dirname, '..');
const ENTRY = join(ROOT, 'dist', 'index.js');
const DOTNET_DLL = process.env.WPF_MCP_DOTNET_DLL ?? join(ROOT, 'server', 'bin', 'Debug', 'net10.0', 'wpf-mcp.dll');
const IS_DOTNET = process.argv.includes('--dotnet');
const TARGET = IS_DOTNET
  ? { entry: DOTNET_DLL, command: 'dotnet', args: [DOTNET_DLL], hint: 'dotnet build server/' }
  : { entry: ENTRY, command: process.execPath, args: [ENTRY], hint: 'npm run build' };

const EXPECTED_TOOLS = [
  'list_wpf_components',
  'get_wpf_api_reference',
  'search_wpf_api',
  'get_wpf_project_scaffold',
  'search_wpf_docs',
  'get_wpf_doc',
  'setup_wpf_theme',
  'get_wpf_theme_resource',
  'get_wpf_theme_palette',
];

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let failures = 0;
const start = performance.now();

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function textOf(r: ToolResult): string {
  return r.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(TARGET.entry)) {
    console.error(`${TARGET.entry} not found — run ${TARGET.hint} first.`);
    process.exit(1);
  }

  const client = new Client({ name: 'wpf-mcp-smoke-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: TARGET.command, args: TARGET.args, stderr: 'pipe' });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));

  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  try {
    console.log('server');
    const info = client.getServerVersion();
    check('reports name/version', info?.name === 'infragistics-wpf' && !!info?.version, JSON.stringify(info));
    check('logs data build info on startup', /data: Infragistics \d+\.\d+\.\d+/.test(stderr.join('')), stderr.join('').trim() || '(no stderr yet)');

    console.log('tools/list');
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    check(`exposes exactly ${EXPECTED_TOOLS.length} tools`, JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), names.join(', '));
    check('every tool is read-only and idempotent',
      tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.idempotentHint === true && t.annotations?.openWorldHint === false));

    console.log('list_wpf_components');
    let r = await call('list_wpf_components', { filter: 'grid' });
    let text = textOf(r);
    check('filter "grid" finds XamDataGrid with its xmlns', !r.isError && text.includes('XamDataGrid') && text.includes('http://infragistics.com/DataPresenter'));
    // The xmlns comes from the DLL's own XmlnsDefinition per namespace, not one guess per assembly
    // (XamTabControl used to get http://schemas.infragistics.com/xaml, which doesn't compile).
    r = await call('list_wpf_components', { filter: 'XamTabControl' });
    check('XamTabControl gets the xmlns its DLL maps it to', !r.isError && textOf(r).includes('xmlns:igWindows="http://infragistics.com/Windows"'), textOf(r).slice(0, 300));
    // Internal classes are not indexed: the XML docs document them too, but no app can use them.
    r = await call('list_wpf_components', { filter: 'Funnel' });
    text = textOf(r);
    check('internal classes are not listed as controls', !r.isError && text.includes('XamFunnelChart') && !text.includes('XamFunnelController') && !text.includes('XamFunnelConnector'), text.slice(0, 300));

    console.log('get_wpf_api_reference');
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'all' });
    text = textOf(r);
    check('XamDataGrid resolves with xmlns and NuGet', !r.isError && text.startsWith('# XamDataGrid') && text.includes('xmlns:igDP=') && text.includes('Infragistics.WPF'));
    check('inherited members are grouped by base type', text.includes('(inherited from `DataPresenterBase`)'), 'no "(inherited from `DataPresenterBase`)" section — enrichWithInheritance did not run');
    // kind: properties — small enough to render every member (inherited ones included) in full.
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'properties' });
    check('property types and enum values are attached', /`[A-Za-z.]+` — values: `/.test(textOf(r)), 'no "`Type` — values: `…`" member line — type-info.json was not merged');
    // Theme classes: their xmlns is http://infragistics.com/Themes, and their static styles come from a generic base.
    r = await call('get_wpf_api_reference', { component: 'DataPresenterRoyalDark' });
    text = textOf(r);
    check('theme class gets the Themes xmlns and its inherited static styles',
      !r.isError && text.includes('xmlns:igThemes="http://infragistics.com/Themes"') && text.includes('**CellValuePresenter** `Style`') && text.includes('(inherited from `DataPresenterResourceSet`1`)'),
      text.slice(0, 400));
    // Static key/command fields are listed (they used to be dropped: DataPresenterCommands showed 0 of 71 commands).
    r = await call('get_wpf_api_reference', { component: 'DataPresenterCommands', kind: 'properties' });
    check('static command fields are listed', !r.isError && textOf(r).includes('**DeleteSelectedDataRecords** `RoutedCommand`'), textOf(r).slice(0, 300));
    // type-info strings are JSON-unescaped (generic type names used to reach agents as Action<ToolCommand>).
    // (C# compacts XamDataChart's inherited properties to names, so ask for the member itself there.)
    r = await call('get_wpf_api_reference', IS_DOTNET ? { component: 'XamDataChart', member: 'CommandCompleted' } : { component: 'XamDataChart', kind: 'properties' });
    check('generic type names are not JSON-escaped', !r.isError && textOf(r).includes('`Action<ToolCommand>`') && !/\\u00[0-9A-F]{2}/.test(textOf(r)));
    // Inheritance follows the exact base type: the chart Axis used to show members of the Excel library's ChartObject.
    r = await call('get_wpf_api_reference', { component: 'Axis', kind: 'properties' });
    check('chart Axis does not inherit from a same-named type', !r.isError && !textOf(r).includes('ChartObject'));
    // Internal classes have no page, and a name an internal class used to win now documents the public class.
    r = await call('get_wpf_api_reference', { component: 'ActivePaneManager' });
    check('internal class has no API page', r.isError === true, textOf(r).slice(0, 200));
    r = await call('get_wpf_api_reference', { component: 'DashboardTileGroupDescription' });
    text = textOf(r);
    check('public type wins its name over an internal one',
      !r.isError && text.includes('`Infragistics.Controls.Dashboards.DashboardTileGroupDescription`') && !text.includes('.Implementation.'), text.slice(0, 400));
    if (IS_DOTNET) {
      // C# only: field label and nested-class XAML name are rendered by the C# server.
      r = await call('get_wpf_api_reference', { component: 'DataPresenterCommands', member: 'DeleteSelectedDataRecords' });
      check('static fields are labelled', !r.isError && textOf(r).includes('`RoutedCommand` _(static field)_'), textOf(r).slice(0, 400));
      r = await call('get_wpf_api_reference', { component: 'ActionBase' });
      check('nested classes show their XAML name', !r.isError && textOf(r).includes('**XAML name:** `igHelpers:ActionHistory+ActionBase`'), textOf(r).slice(0, 400));
    }
    if (IS_DOTNET) {
      // C# only: the TS server has no size guard / member filter.
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart' });
      text = textOf(r);
      check('large type is compacted under 25K chars', !r.isError && text.length <= 25_000 && text.includes('_ℹ️ Compacted:') && text.includes('(inherited from `XamXYChart`)\n`'), `${text.length} chars`);
      // Grids: events/methods go to names first, so the (mostly inherited) properties XAML needs keep full detail.
      for (const grid of ['XamDataGrid', 'XamGrid']) {
        r = await call('get_wpf_api_reference', { component: grid });
        text = textOf(r);
        check(`${grid} compaction keeps full property detail`,
          !r.isError && text.length <= 25_000 && text.includes('events and methods are listed by name only') && /^- \*\*\w+\*\* `[A-Za-z.]+` — values: `/m.test(text),
          `${text.length} chars`);
      }
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'yaxis' });
      text = textOf(r);
      check('member filter returns inherited members in full detail',
        !r.isError && !text.includes('Compacted') && text.includes('(inherited from `XamXYChart`)') && text.includes('- **YAxisLabelLocation** `YAxisLabelLocation` — values: `') && !text.includes('**XAxisLabel**'),
        text.slice(0, 300));
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'NoSuchMemberXyz' });
      check('member filter with no match explains instead of erroring', !r.isError && textOf(r).includes('No members whose name contains "NoSuchMemberXyz"'));
    }
    r = await call('get_wpf_api_reference', { component: 'xamdatagrid', kind: 'events' });
    check('case-insensitive lookup + kind filter', !r.isError && textOf(r).includes('# XamDataGrid'));
    r = await call('get_wpf_api_reference', { component: 'NoSuchTypeXyz', kind: 'all' });
    check('unknown type → isError', r.isError === true);

    console.log('search_wpf_api');
    r = await call('search_wpf_api', { query: 'filter', limit: 5 });
    check('keyword search returns ranked results', !r.isError && textOf(r).includes('# WPF API Search'));
    // "active pane" used to rank the internal ActivePaneManager first.
    r = await call('search_wpf_api', { query: 'active pane', limit: 10 });
    check('search does not return internal classes', !r.isError && !textOf(r).includes('ActivePaneManager'), textOf(r).slice(0, 300));

    console.log('get_wpf_project_scaffold');
    r = await call('get_wpf_project_scaffold', { components: ['XamDataGrid', 'XamCategoryChart'], projectName: 'SmokeApp', framework: 'net10.0' });
    text = textOf(r);
    check('scaffold has dotnet commands and xmlns', !r.isError && text.includes('dotnet new') && text.includes('dotnet add') && text.includes('xmlns:'));

    console.log('search_wpf_docs / get_wpf_doc');
    r = await call('search_wpf_docs', { control: 'XamDataGrid', limit: 5 });
    text = textOf(r);
    const slug = /\*\*Topic slug:\*\* `([^`]+)`/.exec(text)?.[1];
    check('browse by control returns topics with slugs', !r.isError && !!slug, text.slice(0, 300));
    if (slug) {
      r = await call('get_wpf_doc', { topic: slug });
      check(`get_wpf_doc("${slug}") returns body`, !r.isError && textOf(r).length > 200);
    }
    r = await call('search_wpf_docs', { query: 'column series', limit: 3 });
    check('docs-common topics resolved ({CategoryChartName} → real name)', !r.isError && /XamCategoryChart|XamDataChart/.test(textOf(r)), textOf(r).slice(0, 300));
    r = await call('get_wpf_doc', { topic: 'no-such-topic-slug' });
    check('unknown slug → isError', r.isError === true);

    console.log('setup_wpf_theme');
    r = await call('setup_wpf_theme', {});
    text = textOf(r);
    check('lists both theme families', !r.isError && text.includes('MetroDark') && text.includes('ThemeManager') && text.includes('DefaultStyles'), text.slice(0, 300));
    r = await call('setup_wpf_theme', { component: 'DataChart', theme: 'MetroDark' });
    text = textOf(r);
    const path = /`(Themes\/[^`]+\.xaml)`/.exec(text)?.[1];
    check('component+theme filter yields a resource path', !r.isError && !!path, text.slice(0, 300));
    if (IS_DOTNET) {
      // The IG theme's class is IgTheme; `new IGTheme()` does not compile (C# server only — src/ is not updated).
      r = await call('setup_wpf_theme', { component: 'DataChart', theme: 'IG' });
      text = textOf(r);
      check('IG apply block uses the IgTheme class', !r.isError && text.includes('new Infragistics.Themes.IgTheme()') && !text.includes('IGTheme()'), text.slice(0, 600));
    }

    console.log('get_wpf_theme_resource');
    if (path) {
      // C# returns an overview for files over 24K (this one is ~155K) and the XAML by page; the frozen TS server cuts it off.
      r = await call('get_wpf_theme_resource', IS_DOTNET ? { path, page: 1 } : { path });
      check(`returns XAML for ${path}`, !r.isError && textOf(r).includes('<ResourceDictionary'));
    }
    if (IS_DOTNET && path) {
      // Large theme files are no longer cut off: overview, then pages that concatenate to the exact file.
      r = await call('get_wpf_theme_resource', { path });
      text = textOf(r);
      const pageCount = Number(/comes in (\d+) pages/.exec(text)?.[1] ?? 0);
      check('large theme file returns a contents overview', !r.isError && pageCount > 1 && text.includes('## Contents') && text.length <= 25_000, text.slice(0, 300));
      let joined = '';
      for (let p = 1; p <= pageCount; p++) {
        const pr = await call('get_wpf_theme_resource', { path, page: p });
        joined += /```xml\n([\s\S]*)\n```$/.exec(textOf(pr))?.[1] ?? '\u0000';
      }
      const onDisk = readFileSync(join(ROOT, 'src', 'data', 'theme-resources', path), 'utf8').replace(/^﻿/, '');
      check(`its ${pageCount} pages concatenate to the exact file`, joined === onDisk, `${joined.length} vs ${onDisk.length} chars`);
      // 36 matches here, so the result itself takes 2 pages: the root start tag is on the first, the end tag on the last.
      r = await call('get_wpf_theme_resource', { path, find: 'Legend' });
      text = textOf(r);
      const findPages = Number(/\(page 1 of (\d+)\)/.exec(text)?.[1] ?? 1);
      let found = /```xml\n([\s\S]*)\n```$/.exec(text)?.[1] ?? '';
      for (let p = 2; p <= findPages; p++)
        found += /```xml\n([\s\S]*)\n```$/.exec(textOf(await call('get_wpf_theme_resource', { path, find: 'Legend', page: p })))?.[1] ?? '';
      check('find returns matching entries in full, inside the root element',
        !r.isError && /entr(y|ies) matching "Legend"/.test(text) && found.includes('<ResourceDictionary') && found.trimEnd().endsWith('</ResourceDictionary>'),
        text.slice(0, 300));
      r = await call('get_wpf_theme_resource', { path, page: pageCount + 1 });
      check('a page past the end is a clear error', r.isError === true && textOf(r).includes('out of range'));
    }
    r = await call('get_wpf_theme_resource', { path: '../../package.json' });
    check('path traversal is rejected', r.isError === true);

    console.log('get_wpf_theme_palette');
    r = await call('get_wpf_theme_palette', { theme: 'MetroDark' });
    text = textOf(r);
    check('MetroDark palette has color keys', !r.isError && /Color_\d+|Brush\d+/.test(text), text.slice(0, 300));
    r = await call('get_wpf_theme_palette', {});
    check('omitting theme returns the chooser', !r.isError && textOf(r).includes('MetroDark'));
    if (IS_DOTNET) {
      // Overriding palette keys does not recolor a theme (verified); the tool returns verified recolor steps
      // instead, with class names read from each theme's own files (C# server only — src/ is not updated).
      r = await call('get_wpf_theme_palette', { theme: 'RoyalDark' });
      text = textOf(r);
      check('no palette-override skeleton', !r.isError && !text.includes('Override skeleton') && text.includes('does not recolor the theme'), text.slice(-600));
      check('RoyalDark steps name its compiled grid and DockManager classes',
        text.includes('igThemes:DataPresenterRoyalDark.CellValuePresenter') && text.includes('DockManagerRoyalDark_Brushes.xaml') && text.includes('Infragistics.Themes.RoyalDarkTheme'));
      r = await call('get_wpf_theme_palette', { theme: 'IG' });
      text = textOf(r);
      check('IG steps use IgTheme and DataPresenterIGTheme',
        !r.isError && text.includes('Infragistics.Themes.IgTheme') && text.includes('igThemes:DataPresenterIGTheme.CellValuePresenter') && !text.includes('IGTheme()'));
    }
  } finally {
    await client.close();
  }

  const ms = Math.round(performance.now() - start);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed (${ms}ms)`);
    if (stderr.length) console.error(`\nserver stderr:\n${stderr.join('')}`);
    process.exit(1);
  }
  console.log(`\nAll checks passed (${ms}ms).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
