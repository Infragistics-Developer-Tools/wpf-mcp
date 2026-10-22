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
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
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
// Top-level heading of a tool response: the C# server uses `##` (clients render `#` as a page-sized
// title in their tool-result panes), the frozen TS server still uses `#`.
const H1 = IS_DOTNET ? '##' : '#';

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

    console.log('get_wpf_api_reference');
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'all' });
    text = textOf(r);
    check('XamDataGrid resolves with xmlns and NuGet', !r.isError && text.startsWith(`${H1} XamDataGrid\n`) && text.includes('xmlns:igDP=') && text.includes('Infragistics.WPF'));
    check('inherited members are grouped by base type', text.includes('(inherited from `DataPresenterBase`)'), 'no "(inherited from `DataPresenterBase`)" section — enrichWithInheritance did not run');
    // kind: properties — small enough to render every member (inherited ones included) in full.
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'properties' });
    check('property types and enum values are attached', /`[A-Za-z.]+` — values: `/.test(textOf(r)), 'no "`Type` — values: `…`" member line — type-info.json was not merged');
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
      // A full member name must fit the limit: RibbonBrushKeys' static keys run to 74 characters.
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'x'.repeat(128) });
      check('member filter accepts 128 characters', !r.isError && textOf(r).includes('No members whose name contains'), textOf(r).slice(0, 200));
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'x'.repeat(129) });
      check('member over 128 characters → isError naming the limit', r.isError === true && textOf(r).includes('max 128 characters'), textOf(r).slice(0, 200));
    }
    r = await call('get_wpf_api_reference', { component: 'xamdatagrid', kind: 'events' });
    check('case-insensitive lookup + kind filter', !r.isError && textOf(r).includes('# XamDataGrid'));
    r = await call('get_wpf_api_reference', { component: 'NoSuchTypeXyz', kind: 'all' });
    check('unknown type → isError', r.isError === true);

    console.log('search_wpf_api');
    r = await call('search_wpf_api', { query: 'filter', limit: 5 });
    check('keyword search returns ranked results', !r.isError && textOf(r).startsWith(`${H1} WPF API Search`));
    if (IS_DOTNET) {
      // C# only: the TS server returns no results for limit <= 0 and doesn't enforce max lengths.
      r = await call('search_wpf_api', { query: 'filter', limit: 0 });
      check('limit 0 is clamped to 1 result', !r.isError && textOf(r).includes('(1 of '), textOf(r).slice(0, 300));
      r = await call('search_wpf_api', { query: 'filter '.repeat(100) });
      check('over-long query → isError naming the limit', r.isError === true && textOf(r).includes('max 128 characters'), textOf(r).slice(0, 300));
      r = await call('search_wpf_api', { query: '   ' });
      check('blank query → isError', r.isError === true && textOf(r).includes('must not be empty'), textOf(r).slice(0, 300));
    }

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
    if (IS_DOTNET) {
      // C# only: the TS server strips hyphens but not spaces from control names.
      r = await call('search_wpf_docs', { control: 'ThemeManager', limit: 50 });
      text = textOf(r);
      check('control "ThemeManager" matches topics tagged "IG Theme Manager"', !r.isError && text.includes('IG Theme Manager'), text.slice(0, 300));
    }
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

    if (IS_DOTNET) {
      console.log('stderr');
      check('no SDK info lines without --debug', !/^info:/m.test(stderr.join('')), stderr.join('').slice(0, 300));
    }
  } finally {
    await client.close();
  }

  if (IS_DOTNET) {
    // C# only: a second server with --debug; parallel calls must each get a log entry. stderr is
    // ignored, not piped: --debug turns on the SDK's info lines and an unread pipe would fill up.
    console.log('--debug log');
    const logPath = join(tmpdir(), `wpf-mcp-smoke-${process.pid}.log`);
    rmSync(logPath, { force: true });
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const debugClient = new Client({ name: 'wpf-mcp-smoke-test', version: '0.0.0' });
    await debugClient.connect(new StdioClientTransport({
      command: TARGET.command, args: [...TARGET.args, '--debug'], env: { ...env, WPF_MCP_LOG: logPath }, stderr: 'ignore',
    }));
    try {
      const calls = 20;
      await Promise.all(Array.from({ length: calls }, (_, i) =>
        debugClient.callTool({ name: 'search_wpf_api', arguments: { query: `filter ${i}`, limit: 1 } })));
      const entries = existsSync(logPath) ? readFileSync(logPath, 'utf8').match(/^\[[^\]]+\] search_wpf_api \(\d+ms\)$/gm)?.length ?? 0 : 0;
      check(`${calls} parallel calls → ${calls} log entries`, entries === calls, `${entries} entries in ${logPath}`);
    } finally {
      await debugClient.close();
      rmSync(logPath, { force: true });
    }
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
