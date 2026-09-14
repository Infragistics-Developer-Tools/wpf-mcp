#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { TOOL_DESCRIPTIONS } from './tools/constants.js';
import { listComponentsSchema, getApiReferenceSchema, searchApiSchema, getProjectScaffoldSchema, searchDocsSchema, getDocSchema, setupWpfThemeSchema, getWpfThemeResourceSchema, getWpfThemePaletteSchema } from './tools/schemas.js';
import { createListComponentsHandler, createGetApiReferenceHandler, createSearchApiHandler, createGetProjectScaffoldHandler, createSearchDocsHandler, createGetDocHandler, createSetupWpfThemeHandler, createGetWpfThemeResourceHandler, createGetWpfThemePaletteHandler } from './tools/handlers.js';
import type { ComponentEntry, SearchIndexEntry, DocIndexEntry, ThemeIndex } from './lib/types.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
const components: ComponentEntry[] = require('./data/namespaces.json');
const searchIndex: SearchIndexEntry[] = require('./data/search-index.json');
const docIndex: DocIndexEntry[] = existsSync(join(__dirname, 'data/docs-index.json'))
  ? require('./data/docs-index.json')
  : [];
const themeIndex: ThemeIndex = existsSync(join(__dirname, 'data/theme-index.json'))
  ? require('./data/theme-index.json')
  : { newerThemes: [], legacyStyles: [] };

// ── Debug logging ─────────────────────────────────────────────────────────────

const DEBUG = process.argv.includes('--debug');
// Not the install directory — under npx/global installs that is often read-only.
const LOG_PATH = process.env.WPF_MCP_LOG ?? join(tmpdir(), 'wpf-mcp.log');

if (DEBUG) process.stderr.write(`[wpf-mcp] debug log: ${LOG_PATH}\n`);

function log(tool: string, input: Record<string, unknown>, output: string, ms: number): void {
  if (!DEBUG) return;
  const preview = output.length > 400 ? `${output.slice(0, 400)}… (${output.length} chars)` : output;
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${tool} (${ms}ms)\n  IN:  ${JSON.stringify(input)}\n  OUT: ${preview}\n\n`);
  } catch {
    // Logging must never break a tool call.
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'infragistics-wpf', version },
  {
    instructions: `
      Infragistics NetAdvantage for WPF MCP server — component registry, API reference, documentation search, and project scaffolding.

      Canonical workflow — these tools form one chain, follow it in order and reuse the exact names between steps, don't skip ahead to writing XAML:
        1. Resolve the component name: list_wpf_components (Xam* control you can name or want to browse) or search_wpf_api (only know a feature/keyword, e.g. "filter", "export").
        2. get_wpf_api_reference(component) using that exact name for the authoritative member list. If sparse, it names a base type — call it again on that base type.
        3. Whenever the task needs HOW-TO guidance beyond "what members exist" — layouts/nesting, styling/theming, data binding, editing/validation, filtering/sorting/grouping/summaries, exporting, performance, commands, known issues, etc. — call search_wpf_docs(query, control: component), passing the SAME component name from step 1/2 to scope the search.
        4. get_wpf_doc(slug) on the most relevant result from step 3 to read the full XAML example or how-to text before writing any code or giving usage advice.
        5. For new projects, get_wpf_project_scaffold(components) after step 1 for dotnet CLI + xmlns setup, then still run steps 2-4 per component before writing real XAML.
        6. Establish the visual theme EARLY — treat it as a default step for any new window/app, not an optional afterthought. Call setup_wpf_theme(component?, theme?) to pick a named theme and get the exact ready-to-paste apply steps (NuGet package + App.xaml.cs ThemeManager call for the newer family, or Theme="<Name>" for the legacy family) plus the resource file paths; then get_wpf_theme_resource(path) only if you need to copy/override a specific Style/ControlTemplate. When the goal is to RE-COLOR an existing theme (change its palette) rather than restyle one control, call get_wpf_theme_palette(theme) for that theme's centralized color/brush keys and a ready-to-merge override skeleton.

      ALWAYS call list_wpf_components/search_wpf_api before writing any XAML to get the correct xmlns namespace URI; wrong values cause immediate compile errors.
      ALWAYS establish a theme via setup_wpf_theme (then get_wpf_theme_palette to recolor if needed) BEFORE writing any Style, Setter, Brush, or color attribute on an Infragistics control. Do NOT hand-author a color scheme (dark, neon, corporate, etc.) to approximate a look — a named theme or palette override is the correct, lower-maintenance path.
      Never guess property names, child-element nesting, or other usage details (styling, data binding, performance, etc.) — verify through this chain rather than assuming from a similar control or from naming conventions.
    `,
  }
);

// ── Tool registration ─────────────────────────────────────────────────────────

server.registerTool(
  'list_wpf_components',
  {
    description: TOOL_DESCRIPTIONS.list_wpf_components,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: listComponentsSchema,
  },
  createListComponentsHandler(components, themeIndex, log)
);

server.registerTool(
  'get_wpf_api_reference',
  {
    description: TOOL_DESCRIPTIONS.get_wpf_api_reference,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getApiReferenceSchema,
  },
  createGetApiReferenceHandler(components, themeIndex, log)
);

server.registerTool(
  'search_wpf_api',
  {
    description: TOOL_DESCRIPTIONS.search_wpf_api,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: searchApiSchema,
  },
  createSearchApiHandler(searchIndex, log)
);

server.registerTool(
  'get_wpf_project_scaffold',
  {
    description: TOOL_DESCRIPTIONS.get_wpf_project_scaffold,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getProjectScaffoldSchema,
  },
  createGetProjectScaffoldHandler(components, log)
);

server.registerTool(
  'search_wpf_docs',
  {
    description: TOOL_DESCRIPTIONS.search_wpf_docs,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: searchDocsSchema,
  },
  createSearchDocsHandler(docIndex, log)
);

server.registerTool(
  'get_wpf_doc',
  {
    description: TOOL_DESCRIPTIONS.get_wpf_doc,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getDocSchema,
  },
  createGetDocHandler(docIndex, log)
);

server.registerTool(
  'setup_wpf_theme',
  {
    description: TOOL_DESCRIPTIONS.setup_wpf_theme,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: setupWpfThemeSchema,
  },
  createSetupWpfThemeHandler(themeIndex, log)
);

server.registerTool(
  'get_wpf_theme_resource',
  {
    description: TOOL_DESCRIPTIONS.get_wpf_theme_resource,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getWpfThemeResourceSchema,
  },
  createGetWpfThemeResourceHandler(themeIndex, log)
);

server.registerTool(
  'get_wpf_theme_palette',
  {
    description: TOOL_DESCRIPTIONS.get_wpf_theme_palette,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getWpfThemePaletteSchema,
  },
  createGetWpfThemePaletteHandler(themeIndex, log)
);

// ── Transport ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Infragistics WPF MCP server ready');
