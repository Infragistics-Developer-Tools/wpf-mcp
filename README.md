# wpf-mcp

MCP server for **Infragistics NetAdvantage for WPF** — component registry, XAML namespace lookup, full API reference with property types and enum values, keyword search across 6,900+ types, and named-theme setup with palette re-coloring.

Distributed as a NuGet `dotnet tool`, [`Infragistics.Wpf.Mcp`](https://www.nuget.org/packages/Infragistics.Wpf.Mcp), and listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.Infragistics-Developer-Tools/wpf-mcp`.

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

Requires the **.NET 10 runtime** or newer; nothing else — all Infragistics data ships inside the package and nothing is downloaded at runtime.

```bash
dotnet tool install -g Infragistics.Wpf.Mcp
```

The server is then available as the `wpf-mcp` command. With the .NET 10 SDK you can instead let `dnx` fetch and run it on demand: `dnx Infragistics.Wpf.Mcp --yes`.

## MCP client configuration

**Visual Studio** — add `.mcp.json` next to your solution (or `%USERPROFILE%\.mcp.json` for all solutions):

```json
{
  "servers": {
    "infragistics-wpf": {
      "type": "stdio",
      "command": "wpf-mcp"
    }
  }
}
```

**VS Code (Copilot)** — add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "infragistics-wpf": {
      "type": "stdio",
      "command": "wpf-mcp"
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "infragistics-wpf": {
      "command": "wpf-mcp"
    }
  }
}
```

**Claude Code** — from a terminal:

```bash
claude mcp add infragistics-wpf -- wpf-mcp
```

To use `dnx` instead of a global install, set `"command": "dnx"` and `"args": ["Infragistics.Wpf.Mcp", "--yes"]`. Add `"--debug"` to `args` for any client to log every tool call/response to `wpf-mcp.log` in your system temp folder (override with the `WPF_MCP_LOG` environment variable) — see [Troubleshooting](#troubleshooting).

To run from a source checkout instead, build it first (see [DEVELOPMENT.md](DEVELOPMENT.md)) and point `command`/`args` at `dotnet` and `path/to/wpf-mcp/server/bin/Debug/net10.0/wpf-mcp.dll`.

## Troubleshooting

- **Which Infragistics version is the data from?** The server prints it to stderr on startup: `Infragistics WPF MCP server 0.1.0 ready (data: Infragistics 26.1.21, built 2026-09-14)`. Every release regenerates the data from the version pinned in [`nuget/WpfDocs.csproj`](nuget/WpfDocs.csproj).
- **Run the server with `--debug`** (add it to your MCP client config's `args`, see above) to log every tool call's input/output/timing to `wpf-mcp.log` in your system temp folder — useful for reproducing an agent's exact tool-calling sequence after the fact. The exact path is printed to stderr on startup, and can be overridden with the `WPF_MCP_LOG` environment variable.
- **A tool call succeeded but the answer looks wrong or a control seems missing** — this is usually stale/outdated data from Infragistics' own NuGet package (summaries, base types) rather than a bug in this server. Cross-check against the pinned version above before assuming the MCP itself is at fault.
- **A tool returns "no topics found" / "no themes found" for everything** on a source build — the data pipeline didn't complete. Re-run `npm run build:all` and read the output; it either reports real counts or aborts with a 🚨 banner saying exactly what's missing. Published packages are validated against these counts before release, so this can't happen with a NuGet install.

## Contributing

Build pipeline, data updates, adding tools, versioning and the publish process are documented in [DEVELOPMENT.md](https://github.com/Infragistics-Developer-Tools/wpf-mcp/blob/main/DEVELOPMENT.md). The published C# server lives in `server/`. A TypeScript implementation in `src/` reads the same generated data and is kept in sync by a parity test, but it is not published.

## License

[MIT](LICENSE)
