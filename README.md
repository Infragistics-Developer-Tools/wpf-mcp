# wpf-mcp

MCP server for **Infragistics NetAdvantage for WPF** — component registry, XAML namespace lookup, full API reference with property types and enum values, and keyword search across 7,000+ types.

## Tools

| Tool | Description |
|---|---|
| `list_wpf_components` | List all 192 Xam* controls with canonical XAML namespace URIs, NuGet packages, and descriptions. Always call this first before writing XAML. |
| `search_wpf_api` | Search across all 7,000+ types by keyword — matches type names, summaries, and member names. Use when you don't know the exact type name. |
| `get_wpf_api_reference` | Full API reference for any type: properties with types and enum values, events, methods, and inherited members grouped by base class. |

## Requirements

- **Node.js** ≥ 18
- **.NET 8 SDK** — required for the first-time build

## Setup

```bash
git clone <repo>
cd wpf-mcp
npm install
npm run build:all
```

`build:all` downloads Infragistics NuGet packages, extracts type metadata via reflection, merges with XML docs, and compiles the server. Takes 2–5 minutes on first run (NuGet restore), fast after that.

## Claude Desktop configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "infragistics-wpf": {
      "command": "node",
      "args": ["C:/path/to/wpf-mcp/dist/index.js"]
    }
  }
}
```

## Data pipeline

```
NuGet packages (26.2.x)
  ├── *.dll  →  C# TypeExtractor (reflection)  →  nuget/type-info.json
  │                                                 (base types, property types, enum values)
  └── *.xml  ─────────────────────────────────┐
                                               ↓
                                         build-api.ts
                                               ↓
                                    src/data/api/*.json        (7,082 type files)
                                    src/data/namespaces.json   (192 Xam* controls)
                                    src/data/search-index.json (search index)
```

## npm scripts

| Script | What it does |
|---|---|
| `npm run build:all` | Full pipeline: NuGet restore → type extraction → API build → TypeScript compile |
| `npm run generate` | API data only (no TypeScript compile) |
| `npm run generate:types` | C# reflection extractor only → `nuget/type-info.json` |
| `npm run build` | TypeScript compile only (requires `src/data/` to exist) |
| `npm run inspector` | Launch MCP Inspector for interactive testing |

## Development notes

- SDK: `@modelcontextprotocol/sdk` v1 (v2 releases ~July 28 2026 with breaking package renames)
- Zod v3 schemas — upgrade to v4 when migrating to SDK v2
- All tools are read-only (`readOnlyHint: true`, `openWorldHint: false`)
