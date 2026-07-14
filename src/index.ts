#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { TOOL_DESCRIPTIONS } from './tools/constants.js';
import { listComponentsSchema, getApiReferenceSchema } from './tools/schemas.js';
import { createListComponentsHandler, createGetApiReferenceHandler } from './tools/handlers.js';
import type { ComponentEntry } from './lib/types.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const components: ComponentEntry[] = require('./data/namespaces.json');

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
    instructions:
      'Infragistics NetAdvantage for WPF MCP server — component registry and NuGet-sourced API reference. ' +
      'ALWAYS call list_wpf_components before writing any XAML to get the correct xmlns namespace URI and NuGet package. ' +
      'Wrong namespace URIs are the leading cause of compile errors with Infragistics WPF. ' +
      'For full API coverage call get_wpf_api_reference on both the component and its base class — ' +
      'e.g. XamDataGrid + XamDataPresenter, since grid feature properties (DataSource, FieldLayouts, FieldSettings) live on the base.',
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

// ── Transport ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Infragistics WPF MCP server ready');
