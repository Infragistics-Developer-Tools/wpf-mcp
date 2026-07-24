#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { TOOL_DESCRIPTIONS } from './tools/constants.js';
import { listComponentsSchema, getApiReferenceSchema, searchApiSchema, getProjectScaffoldSchema } from './tools/schemas.js';
import { createListComponentsHandler, createGetApiReferenceHandler, createSearchApiHandler, createGetProjectScaffoldHandler } from './tools/handlers.js';
import type { ComponentEntry, SearchIndexEntry } from './lib/types.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const components: ComponentEntry[] = require('./data/namespaces.json');
const searchIndex: SearchIndexEntry[] = require('./data/search-index.json');

// ── Debug logging ─────────────────────────────────────────────────────────────

const DEBUG = process.argv.includes('--debug');
const LOG_PATH = join(__dirname, 'wpf-mcp.log');

function log(tool: string, input: Record<string, unknown>, output: string, ms: number): void {
  if (!DEBUG) return;
  const preview = output.length > 400 ? `${output.slice(0, 400)}… (${output.length} chars)` : output;
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${tool} (${ms}ms)\n  IN:  ${JSON.stringify(input)}\n  OUT: ${preview}\n\n`);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'infragistics-wpf', version: '0.1.0' },
  {
    instructions: `
      Infragistics NetAdvantage for WPF MCP server — component registry, API reference, and project scaffolding.
      ALWAYS call list_wpf_components before writing any XAML to get the correct xmlns namespace URI; wrong values cause immediate compile errors.
      To look up any Infragistics type: use search_wpf_api to discover the name, then get_wpf_api_reference for full members.
      For Xam* controls, list_wpf_components gives the name directly.
      Infragistics controls commonly expose their API through base classes — if get_wpf_api_reference returns a sparse member list, call it again on the parent type to get the full surface.
      For new WPF projects: call list_wpf_components to resolve component names, then get_project_scaffold for all dotnet CLI commands and xmlns declarations.
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
  createListComponentsHandler(components, log)
);

server.registerTool(
  'get_wpf_api_reference',
  {
    description: TOOL_DESCRIPTIONS.get_wpf_api_reference,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getApiReferenceSchema,
  },
  createGetApiReferenceHandler(components, log)
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
  'get_project_scaffold',
  {
    description: TOOL_DESCRIPTIONS.get_project_scaffold,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: getProjectScaffoldSchema,
  },
  createGetProjectScaffoldHandler(components, log)
);

// ── Transport ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Infragistics WPF MCP server ready');
