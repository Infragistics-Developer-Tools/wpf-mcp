# wpf-mcp

MCP server for **Infragistics NetAdvantage for WPF** — component registry, XAML namespace lookup, full API reference with property types and enum values, keyword search across 6,900+ types, and named-theme setup with palette re-coloring.

Available as an npm package ([`@infragistics/wpf-mcp-server`](https://www.npmjs.com/package/@infragistics/wpf-mcp-server), this README) and as a NuGet `dotnet tool` ([`Infragistics.Wpf.Mcp`](https://www.nuget.org/packages/Infragistics.Wpf.Mcp), [its README](https://github.com/Infragistics-Developer-Tools/wpf-mcp/blob/main/server/README.md)). Same server, same data, identical results — pick whichever runtime you already have.

## Tools

All tools are read-only (`readOnlyHint: true`, `openWorldHint: false`) — none of them modify your project, filesystem, or any external system.

| Tool | Description |
|---|---|
| `list_wpf_components` | List all 191 Xam* controls with canonical XAML namespace URIs, NuGet packages, and descriptions. Always call this first before writing XAML. |
| `get_wpf_project_scaffold` | Generate ready-to-run `dotnet new` + `dotnet add package` + `dotnet restore` commands and xmlns declarations for a new WPF project. Pass component names resolved via `list_wpf_components`. |
| `search_wpf_api` | Search across all 6,900+ types by keyword — matches type names, summaries, and member names. Use when you don't know the exact type name. |
| `get_wpf_api_reference` | Full API reference for any type: properties with types and enum values, events, methods, and inherited members grouped by base class. |
| `setup_wpf_theme` | List available named themes and the raw XAML files backing them, covering both theming mechanisms (legacy embedded-BAML `Theme="..."` and newer `ThemeManager`). Returns ready-to-paste apply steps. Call first for any theming task. |
| `get_wpf_theme_resource` | Retrieve the full raw XAML of one theme/style resource-dictionary file (real `Style`/`ControlTemplate`/brush definitions) to copy and override. Use the exact `path` from `setup_wpf_theme`. |
| `get_wpf_theme_palette` | Return a newer-family (ThemeManager) theme's centralized color/brush palette — exact resource keys, values, and a ready-to-merge override skeleton — for re-coloring a theme without creating a new one. |
| `search_wpf_docs` | Search 2,600+ how-to documentation topics by keyword and/or control name — layouts, styling, data binding, filtering/sorting/grouping, exporting, performance, known issues, etc. |
| `get_wpf_doc` | Full text (including XAML samples) of one documentation topic by slug. Use the `slug` from a `search_wpf_docs` result. |

## Installation

Requires **Node.js ≥ 20**; nothing else — all Infragistics data ships inside the package and nothing is downloaded at runtime. Listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.Infragistics-Developer-Tools/wpf-mcp`.

```bash
npx -y @infragistics/wpf-mcp-server
```

Prefer .NET? `dotnet tool install -g Infragistics.Wpf.Mcp` gives you the same server as the `wpf-mcp` command (or `dnx Infragistics.Wpf.Mcp --yes` with the .NET 10 SDK) — see the [NuGet package README](https://github.com/Infragistics-Developer-Tools/wpf-mcp/blob/main/server/README.md) for its client configuration.

## MCP client configuration

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "infragistics-wpf": {
      "command": "npx",
      "args": ["-y", "@infragistics/wpf-mcp-server"]
    }
  }
}
```

**VS Code (Copilot)** — add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "infragistics-wpf": {
      "command": "npx",
      "args": ["-y", "@infragistics/wpf-mcp-server"]
    }
  }
}
```

**Claude Code** — from a terminal:

```bash
claude mcp add infragistics-wpf -- npx -y @infragistics/wpf-mcp-server
```

Add `"--debug"` to `args` (or after the package name) for any client to log every tool call/response to `wpf-mcp.log` in your system temp folder (override with the `WPF_MCP_LOG` environment variable) — see [Troubleshooting](#troubleshooting).

To run from a source checkout instead, build it first (see [DEVELOPMENT.md](DEVELOPMENT.md)) and point `command`/`args` at `node` and `path/to/wpf-mcp/dist/index.js` (or `dotnet` and `path/to/wpf-mcp/server/bin/Debug/net8.0/wpf-mcp.dll`).

## Troubleshooting

- **Which Infragistics version is the data from?** The server prints it to stderr on startup: `Infragistics WPF MCP server 0.1.0 ready (data: Infragistics 26.1.21, built 2026-09-14)`. Every release regenerates the data from the version pinned in [`nuget/WpfDocs.csproj`](nuget/WpfDocs.csproj).
- **Run the server with `--debug`** (add it to your MCP client config's `args`, see above) to log every tool call's input/output/timing to `wpf-mcp.log` in your system temp folder — useful for reproducing an agent's exact tool-calling sequence after the fact. The exact path is printed to stderr on startup, and can be overridden with the `WPF_MCP_LOG` environment variable.
- **A tool call succeeded but the answer looks wrong or a control seems missing** — this is usually stale/outdated data from Infragistics' own NuGet package (summaries, base types) rather than a bug in this server. Cross-check against the pinned version above before assuming the MCP itself is at fault.
- **A tool returns "no topics found" / "no themes found" for everything** on a source build — the data pipeline didn't complete. Re-run `npm run build:all` and read the output; it either reports real counts or aborts with a 🚨 banner saying exactly what's missing. Published packages are validated against these counts before release, so this can't happen with an npm or NuGet install.
- **npm and NuGet give different answers?** They shouldn't — CI runs a parity test that diffs every tool's output between the two runtimes before a release. If you see a difference, please [open an issue](https://github.com/Infragistics-Developer-Tools/wpf-mcp/issues) with the tool call.

## Contributing

Build pipeline, data updates, adding tools, versioning and the publish process are documented in [DEVELOPMENT.md](https://github.com/Infragistics-Developer-Tools/wpf-mcp/blob/main/DEVELOPMENT.md). The TypeScript server lives in `src/`, the C# server in `server/`; both read the same generated data.

## License

[MIT](LICENSE)
