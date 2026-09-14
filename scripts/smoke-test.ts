#!/usr/bin/env tsx
/**
 * smoke-test.ts
 *
 * Starts the built server (dist/index.js) over stdio exactly as an MCP client would,
 * then exercises every tool once against the real data set. This is the `npm test`
 * gate for CI and publishing: a build whose data is present but wrong (empty index,
 * missing inheritance, broken path guard) passes validate-package's counts but not this.
 *
 * Prerequisite: npm run build (dist/ must exist).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dirname, '..');
const ENTRY = join(ROOT, 'dist', 'index.js');

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
  if (!existsSync(ENTRY)) {
    console.error(`dist/index.js not found — run npm run build first.`);
    process.exit(1);
  }

  const client = new Client({ name: 'wpf-mcp-smoke-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: 'pipe' });
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

    console.log('get_wpf_api_reference');
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'all' });
    text = textOf(r);
    check('XamDataGrid resolves with xmlns and NuGet', !r.isError && text.startsWith('# XamDataGrid') && text.includes('xmlns:igDP=') && text.includes('Infragistics.WPF'));
    check('inherited members are grouped by base type', text.includes('(inherited from `DataPresenterBase`)'), 'no "(inherited from `DataPresenterBase`)" section — enrichWithInheritance did not run');
    check('property types and enum values are attached', /`[A-Za-z.]+` — values: `/.test(text), 'no "`Type` — values: `…`" member line — type-info.json was not merged');
    r = await call('get_wpf_api_reference', { component: 'xamdatagrid', kind: 'events' });
    check('case-insensitive lookup + kind filter', !r.isError && textOf(r).includes('# XamDataGrid'));
    r = await call('get_wpf_api_reference', { component: 'NoSuchTypeXyz', kind: 'all' });
    check('unknown type → isError', r.isError === true);

    console.log('search_wpf_api');
    r = await call('search_wpf_api', { query: 'filter', limit: 5 });
    check('keyword search returns ranked results', !r.isError && textOf(r).includes('# WPF API Search'));

    console.log('get_wpf_project_scaffold');
    r = await call('get_wpf_project_scaffold', { components: ['XamDataGrid', 'XamCategoryChart'], projectName: 'SmokeApp', framework: 'net8.0' });
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

    console.log('get_wpf_theme_resource');
    if (path) {
      r = await call('get_wpf_theme_resource', { path });
      check(`returns XAML for ${path}`, !r.isError && textOf(r).includes('<ResourceDictionary'));
    }
    r = await call('get_wpf_theme_resource', { path: '../../package.json' });
    check('path traversal is rejected', r.isError === true);

    console.log('get_wpf_theme_palette');
    r = await call('get_wpf_theme_palette', { theme: 'MetroDark' });
    text = textOf(r);
    check('MetroDark palette has color keys', !r.isError && /Color_\d+|Brush\d+/.test(text), text.slice(0, 300));
    r = await call('get_wpf_theme_palette', {});
    check('omitting theme returns the chooser', !r.isError && textOf(r).includes('MetroDark'));
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
