# wpf-mcp

MCP server for **Infragistics NetAdvantage for WPF** — component registry, XAML namespace lookup, full API reference with property types and enum values, keyword search across 7,000+ types, and named-theme setup with palette re-coloring.

## Tools

| Tool | Description |
|---|---|
| `list_wpf_components` | List all 192 Xam* controls with canonical XAML namespace URIs, NuGet packages, and descriptions. Always call this first before writing XAML. |
| `get_project_scaffold` | Generate ready-to-run `dotnet new` + `dotnet add package` + `dotnet restore` commands and xmlns declarations for a new WPF project. Pass component names resolved via `list_wpf_components`. |
| `search_wpf_api` | Search across all 7,000+ types by keyword — matches type names, summaries, and member names. Use when you don't know the exact type name. |
| `get_wpf_api_reference` | Full API reference for any type: properties with types and enum values, events, methods, and inherited members grouped by base class. |
| `setup_wpf_theme` | List available named themes and the raw XAML files backing them, covering both theming mechanisms (legacy embedded-BAML `Theme="..."` and newer `ThemeManager`). Returns ready-to-paste apply steps. Call first for any theming task. |
| `get_wpf_theme_resource` | Retrieve the full raw XAML of one theme/style resource-dictionary file (real `Style`/`ControlTemplate`/brush definitions) to copy and override. Use the exact `path` from `setup_wpf_theme`. |
| `get_wpf_theme_palette` | Return a newer-family (ThemeManager) theme's centralized color/brush palette — exact resource keys, values, and a ready-to-merge override skeleton — for re-coloring a theme without creating a new one. |
| `search_wpf_docs` | Search 2,600+ how-to documentation topics by keyword and/or control name — layouts, styling, data binding, filtering/sorting/grouping, exporting, performance, known issues, etc. |
| `get_wpf_doc` | Full text (including XAML samples) of one documentation topic by slug. Use the `slug` from a `search_wpf_docs` result. |

## Requirements

- **Node.js** ≥ 18
- **.NET 8 SDK** — required for the first-time build

## Setup

```bash
git clone --recurse-submodules <repo>
cd wpf-mcp
npm install
npm run build:all
```

`build:all` downloads Infragistics NuGet packages, extracts type metadata via reflection, merges with XML docs, builds the docs/theme indexes, and compiles the server. Takes 2–5 minutes on first run (NuGet restore), fast after that.

### Submodules (docs-wpf, docs-common, wpf-resources)

`docs/docs-wpf`, `docs/docs-common`, and `docs/wpf-resources` are git submodules — they back `search_wpf_docs`/`get_wpf_doc` and `setup_wpf_theme`/`get_wpf_theme_resource`/`get_wpf_theme_palette`. If you cloned without `--recurse-submodules`, don't worry: `npm run build:all` (via `build:docs`/`build:themes`) auto-detects missing submodules and runs `git submodule update --init --recursive` for you, no manual step needed as long as you have network access to GitHub. If that still can't populate them (e.g. offline), the build aborts loudly with the exact fix command instead of silently shipping an empty docs/theme index. Run `npm run ensure-submodules` any time to check/fix this on its own.

### Using a private or local NuGet feed

By default, `npm run generate` (via the `docs:restore` script) restores the public **Trial** packages referenced in [`nuget/WpfDocs.csproj`](nuget/WpfDocs.csproj) from nuget.org. If you need to restore from a private feed (e.g. an internal package server) or an offline local folder feed instead, add a `nuget.config` file next to `WpfDocs.csproj` (i.e. in `nuget/nuget.config`) — `dotnet restore` picks it up automatically.

**Local folder feed:**

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local-feed" value="C:\path\to\local\feed" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
```

**Authenticated private feed:**

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="private-feed" value="https://your-private-feed/index.json" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <private-feed>
      <add key="Username" value="%FEED_USERNAME%" />
      <add key="ClearTextPassword" value="%FEED_PASSWORD%" />
    </private-feed>
  </packageSourceCredentials>
</configuration>
```

Set `FEED_USERNAME` / `FEED_PASSWORD` as environment variables (or use `dotnet nuget add source https://your-private-feed/index.json --name private-feed --username %FEED_USERNAME% --password %FEED_PASSWORD%` to add the source; omit `--store-password-in-clear-text` to avoid clear-text storage). **Never commit a `nuget.config` containing real credentials** — add it to `.gitignore` if it holds anything other than placeholder env-var references.

## MCP client configuration

**Claude Desktop** — add to `claude_desktop_config.json`:

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

**VS Code (Copilot)** — add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "infragistics-wpf": {
      "command": "node",
      "args": ["C:/path/to/wpf-mcp/dist/index.js"]
    }
  }
}
```

Add `"--debug"` to `args` for either client to log every tool call/response to `dist/wpf-mcp.log` — see [Troubleshooting](#troubleshooting).

## Data pipeline

```
NuGet packages (26.1.x)
  ├── *.dll  →  C# TypeExtractor (reflection)  →  nuget/type-info.json
  │                                                 (base types, property types, enum values)
  └── *.xml  ─────────────────────────────────┐
                                               ↓
                                         build-api.ts
                                               ↓
                                    src/data/api/*.json        (7,084 type files)
                                    src/data/namespaces.json   (192 Xam* controls)
                                    src/data/search-index.json (search index)

docs/docs-wpf + docs/docs-common submodules  →  build-docs.ts   →  src/data/docs-index.json + src/data/docs/*.json
docs/wpf-resources submodule                 →  build-themes.ts →  src/data/theme-index.json + src/data/theme-resources/
```

Every step above validates its own output before finishing: a submodule/package that's missing or produces zero usable data aborts the build loudly (with the exact fix command) instead of silently shipping an empty or degraded index.

## npm scripts

| Script | What it does |
|---|---|
| `npm run build:all` | Full pipeline: NuGet restore → type extraction → API build → docs build → themes build → TypeScript compile |
| `npm run generate` | API data only: NuGet restore → type extraction → API build (no TypeScript compile) |
| `npm run generate:types` | C# reflection extractor only → `nuget/type-info.json` |
| `npm run docs:restore` | `dotnet restore` the trial NuGet packages referenced in `nuget/WpfDocs.csproj` |
| `npm run build:docs` | Docs index only, from the `docs-wpf`/`docs-common` submodules (auto-inits them if missing) |
| `npm run build:themes` | Theme index only, from the `wpf-resources` submodule (auto-inits it if missing) |
| `npm run ensure-submodules` | Check/auto-init all 3 doc/theme submodules on their own, without building anything |
| `npm run docs:update` | Pull the latest commit for all 3 doc/theme submodules |
| `npm run build` | TypeScript compile only (requires `src/data/` to exist) |
| `npm run inspector` | Launch MCP Inspector for interactive testing |

## Troubleshooting

- **A tool returns "no topics found" / "no themes found" for everything.** This used to mean the docs/theme submodules weren't initialized and silently built an empty index. As of the fail-loud guarantee above, a bad build now aborts instead of shipping — so if you're hitting this, the build likely never actually ran, or `dist/` predates this fix. Re-run `npm run build:all` and read the full output; it will either succeed with real counts ("Topics written: 2618", "8 newer themes, 45 legacy style folders", etc.) or abort with a 🚨-banner explaining exactly what's missing.
- **Run the server with `--debug`** (add it to your MCP client config's `args`, see above) to log every tool call's input/output/timing to `dist/wpf-mcp.log` — useful for reproducing an agent's exact tool-calling sequence after the fact.
- **A tool call succeeded but the answer looks wrong or a control seems missing** — this is usually stale/outdated data from Infragistics' own NuGet package (summaries, base types) rather than a bug in this server. Cross-check against `nuget/WpfDocs.csproj`'s pinned version before assuming the MCP itself is at fault.

## Development notes

- SDK: `@modelcontextprotocol/sdk` v1 (v2 releases ~July 28 2026 with breaking package renames)
- Zod v3 schemas — upgrade to v4 when migrating to SDK v2
- All tools are read-only (`readOnlyHint: true`, `openWorldHint: false`)

---

<details>
<summary><strong>Architecture</strong></summary>

### Why this approach

Infragistics WPF NuGet packages ship two files per assembly:
- `InfragisticsWPF.*.dll` — the actual binary
- `InfragisticsWPF.*.xml` — compiler-generated XML doc comments (`<summary>`, `<param>`, etc.)

The XML files give you descriptions but nothing else — no property types, no enum values, no inheritance. The only way to get that is reflection on the DLL. That's also what Infragistics' own documentation tool (Innovasys Document! X) does internally before generating their live help site.

### Build pipeline

```
NuGet packages
  ├─ *.dll ──► scripts/type-extractor/Program.cs  (C#, reflection)
  │               Loads all Infragistics DLLs into one AssemblyLoadContext
  │               Walks every public type: base type, properties with types,
  │               enum members, nullability
  │               Output: nuget/type-info.json  (36k entries, compact JSON)
  │
  └─ *.xml ──► scripts/build-api.ts  (TypeScript)
                  Parses XML docs per assembly using split-based chunking
                  (avoids catastrophic regex backtracking on multi-MB files)
                  Builds a Map<typeFQN, members> per file (O(n), not O(n²))
                  Merges with type-info.json to attach typeName/enumValues
                  Walks __baseType chain with cycle guard for inherited props
                  Writes async parallel: src/data/api/{TypeName}.json (7k files)
                  Also writes: src/data/namespaces.json, src/data/search-index.json
```

### Runtime data layout

| File | Size | Loaded | Purpose |
|---|---|---|---|
| `src/data/namespaces.json` | ~50KB | At startup | 192 Xam* control registry |
| `src/data/search-index.json` | ~5MB | At startup | Compact index: name + summary + member names |
| `src/data/api/{Type}.json` | ~5–15KB each | On demand | Full member details per type |

The search index is loaded once and kept in memory — search never touches individual type files. `get_wpf_api_reference` loads exactly one file per call.

### Key design decisions

- **No reflection at query time** — all reflection happens at build time. MCP responses are pure JSON file reads.
- **`type-info.json` is gitignored** — regenerated by `build:all`. Users need .NET 8 SDK for first build.
- **`src/data/` is gitignored** — regenerated from `type-info.json` + NuGet XMLs by `build-api.ts`.
- **Inheritance enrichment** — `enrichWithInheritance()` walks `__baseType` chains and copies parent properties to child entries with a `declaredOn` label. This is why `XamDataGrid` shows 74 properties even though it declares very few directly.
- **`internal` filter** — members with `summary === "internal"` are stripped. These are public DLL members that developers wrote placeholder docs for but aren't part of the public API surface.

</details>
