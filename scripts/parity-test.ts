#!/usr/bin/env tsx
/**
 * parity-test.ts
 *
 * Drives the Node server (dist/index.js) and the C# server (server/bin/.../wpf-mcp.dll)
 * over stdio with the same fixed set of tool calls and diffs everything a client can
 * observe: instructions, tool list (names, descriptions, annotations), and each call's
 * text + isError. Any difference is a failure — the two runtimes must be interchangeable.
 *
 * Prerequisites: npm run build, and dotnet build server/ (or set WPF_MCP_DOTNET_DLL).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NODE_ENTRY = join(ROOT, 'dist', 'index.js');
const DOTNET_DLL = process.env.WPF_MCP_DOTNET_DLL ?? join(ROOT, 'server', 'bin', 'Debug', 'net8.0', 'wpf-mcp.dll');

type Call = { tool: string; args: Record<string, unknown> };

const CALLS: Call[] = [
  { tool: 'list_wpf_components', args: {} },
  { tool: 'list_wpf_components', args: { filter: 'grid' } },
  { tool: 'list_wpf_components', args: { filter: 'chart' } },
  { tool: 'list_wpf_components', args: { filter: 'Dock' } },
  { tool: 'list_wpf_components', args: { filter: 'editor' } },
  { tool: 'list_wpf_components', args: { filter: 'XamDataGrid' } },
  { tool: 'list_wpf_components', args: { filter: 'zzz' } },

  { tool: 'get_wpf_api_reference', args: { component: 'XamDataGrid', kind: 'all' } },
  { tool: 'get_wpf_api_reference', args: { component: 'xamdatagrid', kind: 'events' } },
  { tool: 'get_wpf_api_reference', args: { component: 'XamDataGrid', kind: 'properties' } },
  { tool: 'get_wpf_api_reference', args: { component: 'XamDataGrid', kind: 'methods' } },
  { tool: 'get_wpf_api_reference', args: { component: 'XamCategoryChart' } },
  { tool: 'get_wpf_api_reference', args: { component: 'FieldLayout' } },
  { tool: 'get_wpf_api_reference', args: { component: 'AdornmentInfo' } },
  { tool: 'get_wpf_api_reference', args: { component: 'ActionFilter' } },
  { tool: 'get_wpf_api_reference', args: { component: 'ActionFilter', kind: 'methods' } },
  { tool: 'get_wpf_api_reference', args: { component: 'NoSuchTypeXyz' } },

  { tool: 'search_wpf_api', args: { query: 'filter', limit: 5 } },
  { tool: 'search_wpf_api', args: { query: 'FieldSettings AllowEdit' } },
  { tool: 'search_wpf_api', args: { query: 'XamDataGrid sort', limit: 50 } },
  { tool: 'search_wpf_api', args: { query: 'zzzqqq' } },
  { tool: 'search_wpf_api', args: { query: 'zzz qqq' } },

  { tool: 'get_wpf_project_scaffold', args: { components: ['XamDataGrid', 'XamCategoryChart'], projectName: 'SmokeApp', framework: 'net8.0' } },
  { tool: 'get_wpf_project_scaffold', args: { components: ['xamdatagrid', 'XamDataGrid', 'Nope', 'Grid'], framework: 'net6.0' } },
  { tool: 'get_wpf_project_scaffold', args: { components: ['Nope'] } },
  { tool: 'get_wpf_project_scaffold', args: { components: ['XamDataGrid'], projectName: '1bad' } },

  { tool: 'search_wpf_docs', args: { control: 'XamDataGrid', limit: 5 } },
  { tool: 'search_wpf_docs', args: { query: 'column series', limit: 3 } },
  { tool: 'search_wpf_docs', args: { query: 'restrict floating', control: 'XamDockManager' } },
  { tool: 'search_wpf_docs', args: { control: 'financial-chart', limit: 50 } },
  { tool: 'search_wpf_docs', args: { query: 'getting started grouping summary export' } },
  { tool: 'search_wpf_docs', args: {} },
  { tool: 'search_wpf_docs', args: { control: 'zzz' } },
  { tool: 'search_wpf_docs', args: { query: 'zzz', control: 'XamDataGrid' } },
  { tool: 'search_wpf_docs', args: { query: 'zzz' } },

  { tool: 'get_wpf_doc', args: { topic: 'adding-assembly-to-a-visual-studio-project' } },
  { tool: 'get_wpf_doc', args: { topic: 'ANDROID-ADDING-LINEAR-GAUGE' } },
  { tool: 'get_wpf_doc', args: { topic: 'datachart-financial-indicators-overview' } },
  { tool: 'get_wpf_doc', args: { topic: 'no-such-topic-slug' } },
  { tool: 'get_wpf_doc', args: { topic: 'financial' } },

  { tool: 'setup_wpf_theme', args: {} },
  { tool: 'setup_wpf_theme', args: { component: 'DataChart', theme: 'MetroDark' } },
  { tool: 'setup_wpf_theme', args: { component: 'grid' } },
  { tool: 'setup_wpf_theme', args: { component: 'XamDataGrid' } },
  { tool: 'setup_wpf_theme', args: { component: 'Ribbon' } },
  { tool: 'setup_wpf_theme', args: { theme: 'Office2013' } },
  { tool: 'setup_wpf_theme', args: { component: 'RibbonMetroDark' } },
  { tool: 'setup_wpf_theme', args: { component: 'zzz' } },
  { tool: 'setup_wpf_theme', args: { component: '  ', theme: 'RoyalDark' } },

  { tool: 'get_wpf_theme_resource', args: { path: 'Themes/IG/IG.DataVisualization.xaml' } },
  { tool: 'get_wpf_theme_resource', args: { path: 'DefaultStyles/ColorPicker/generic.xaml' } },
  { tool: 'get_wpf_theme_resource', args: { path: 'Themes\\MetroDark\\MetroDark.Theme.Colors.xaml' } },
  { tool: 'get_wpf_theme_resource', args: { path: '../../package.json' } },
  { tool: 'get_wpf_theme_resource', args: { path: 'Themes/' } },
  { tool: 'get_wpf_theme_resource', args: { path: 'Themes/MetroDark/nope.xaml' } },

  { tool: 'get_wpf_theme_palette', args: {} },
  { tool: 'get_wpf_theme_palette', args: { theme: 'MetroDark' } },
  { tool: 'get_wpf_theme_palette', args: { theme: 'metro' } },
  { tool: 'get_wpf_theme_palette', args: { theme: 'Royal', filter: 'accent' } },
  { tool: 'get_wpf_theme_palette', args: { theme: 'Office2013', filter: 'zzz' } },
  { tool: 'get_wpf_theme_palette', args: { theme: 'NoTheme' } },
];

type Snapshot = {
  instructions: string;
  tools: Array<{ name: string; description?: string; annotations?: unknown }>;
  calls: Array<{ isError: boolean; text: string }>;
};

async function snapshot(command: string, args: string[]): Promise<Snapshot> {
  const client = new Client({ name: 'wpf-mcp-parity-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command, args, stderr: 'pipe' }));
  try {
    const { tools } = await client.listTools();
    const calls = [];
    for (const c of CALLS) {
      const r = await client.callTool({ name: c.tool, arguments: c.args }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      calls.push({ isError: !!r.isError, text: r.content.filter(x => x.type === 'text').map(x => x.text ?? '').join('\n') });
    }
    return {
      instructions: (client.getInstructions() ?? '').trim(),
      tools: tools.map(t => ({ name: t.name, description: t.description, annotations: t.annotations })).sort((a, b) => a.name.localeCompare(b.name)),
      calls,
    };
  } finally {
    await client.close();
  }
}

function firstDiff(a: string, b: string): string {
  const al = a.split('\n'), bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}:\n        node:   ${al[i] ?? '<EOF>'}\n        dotnet: ${bl[i] ?? '<EOF>'}`;
  }
  return '(identical lines, differs in line endings?)';
}

async function main(): Promise<void> {
  for (const [label, path] of [['dist/index.js', NODE_ENTRY], ['C# server', DOTNET_DLL]] as const) {
    if (!existsSync(path)) {
      console.error(`${label} not found at ${path} — build it first.`);
      process.exit(1);
    }
  }

  const start = performance.now();
  const [node, dotnet] = await Promise.all([
    snapshot(process.execPath, [NODE_ENTRY]),
    snapshot('dotnet', [DOTNET_DLL]),
  ]);

  let failures = 0;
  const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);

  console.log('server');
  node.instructions === dotnet.instructions ? ok('instructions match') : fail(`instructions differ at ${firstDiff(node.instructions, dotnet.instructions)}`);

  console.log('tools/list');
  const nodeNames = node.tools.map(t => t.name).join(','), dotnetNames = dotnet.tools.map(t => t.name).join(',');
  nodeNames === dotnetNames ? ok(`same ${node.tools.length} tools`) : fail(`tool names differ:\n        node:   ${nodeNames}\n        dotnet: ${dotnetNames}`);
  for (const t of node.tools) {
    const d = dotnet.tools.find(x => x.name === t.name);
    if (!d) continue;
    if (t.description !== d.description) fail(`${t.name}: description differs at ${firstDiff(t.description ?? '', d.description ?? '')}`);
    if (JSON.stringify(t.annotations) !== JSON.stringify(d.annotations)) fail(`${t.name}: annotations differ (${JSON.stringify(t.annotations)} vs ${JSON.stringify(d.annotations)})`);
  }
  if (nodeNames === dotnetNames && failures === 0) ok('descriptions and annotations match');

  console.log('tools/call');
  CALLS.forEach((c, i) => {
    const a = node.calls[i], b = dotnet.calls[i];
    const label = `${c.tool} ${JSON.stringify(c.args)}`;
    if (a.isError !== b.isError) fail(`${label}: isError ${a.isError} vs ${b.isError}`);
    else if (a.text !== b.text) fail(`${label}: text differs (${a.text.length} vs ${b.text.length} chars) at ${firstDiff(a.text, b.text)}`);
    else ok(`${label}${a.isError ? ' (error)' : ''} — ${a.text.length} chars`);
  });

  const ms = Math.round(performance.now() - start);
  if (failures > 0) {
    console.error(`\n${failures} parity check(s) failed (${ms}ms)`);
    process.exit(1);
  }
  console.log(`\nAll ${CALLS.length} calls identical across runtimes (${ms}ms).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
