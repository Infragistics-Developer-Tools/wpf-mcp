# Infragistics WPF MCP Server

MCP server for **Infragistics NetAdvantage for WPF** — component registry, XAML namespace lookup, full API reference with property types and enum values, keyword search across 6,900+ types, 2,600+ documentation topics, and named-theme setup with palette re-coloring. Everything an AI coding agent needs to write correct Infragistics XAML instead of guessing.

Packaged as a `dotnet tool`. All Infragistics data ships inside the package; nothing is downloaded at runtime, and every tool is read-only.

## Install

Requires the **.NET 8 runtime** or newer.

```bash
dotnet tool install -g Infragistics.Wpf.Mcp
```

The server is then available as the `wpf-mcp` command. Update later with `dotnet tool update -g Infragistics.Wpf.Mcp`; add `--prerelease` to either command for preview versions.

With the .NET 10 SDK you can skip the install and let `dnx` fetch and run it on demand, like `npx`:

```bash
dnx Infragistics.Wpf.Mcp --yes
```

## Configure your MCP client

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

To use `dnx` instead of a global install, set `"command": "dnx"` and `"args": ["Infragistics.Wpf.Mcp", "--yes"]` in any of the above (`claude mcp add infragistics-wpf -- dnx Infragistics.Wpf.Mcp --yes`).

## Tools

| Tool | Description |
|---|---|
| `list_wpf_components` | List all Xam* controls with canonical XAML namespace URIs, NuGet packages, and descriptions. Always call this first before writing XAML. |
| `get_wpf_project_scaffold` | Generate ready-to-run `dotnet new` + `dotnet add package` + `dotnet restore` commands and xmlns declarations for a new WPF project. |
| `search_wpf_api` | Search across all types by keyword — matches type names, summaries, and member names. Use when you don't know the exact type name. |
| `get_wpf_api_reference` | Full API reference for any type: properties with types and enum values, events, methods, and inherited members grouped by base class. |
| `setup_wpf_theme` | List available named themes and the raw XAML files backing them, covering both theming mechanisms (legacy embedded-BAML `Theme="..."` and newer `ThemeManager`). Returns ready-to-paste apply steps. |
| `get_wpf_theme_resource` | Retrieve the full raw XAML of one theme/style resource-dictionary file (real `Style`/`ControlTemplate`/brush definitions) to copy and override. |
| `get_wpf_theme_palette` | Return a newer-family (ThemeManager) theme's centralized color/brush palette — exact resource keys, values, and a ready-to-merge override skeleton — for re-coloring a theme without creating a new one. |
| `search_wpf_docs` | Search how-to documentation topics by keyword and/or control name — layouts, styling, data binding, filtering/sorting/grouping, exporting, performance, known issues, etc. |
| `get_wpf_doc` | Full text (including XAML samples) of one documentation topic by slug. |

All tools are annotated `readOnlyHint: true`, `openWorldHint: false` — none of them modify your project, filesystem, or any external system.

## Troubleshooting

- **Which Infragistics version is the data from?** The server prints it to stderr on startup: `Infragistics WPF MCP server 1.2.3 ready (data: Infragistics 26.1.21, built 2026-09-14)`.
- **Log every tool call** — add `"args": ["--debug"]` to the client configuration. Each call's input, output and timing goes to `wpf-mcp.log` in your system temp folder (override with the `WPF_MCP_LOG` environment variable); the exact path is printed to stderr on startup.
- **`wpf-mcp` is not found** after `dotnet tool install -g` — the global tools folder (`%USERPROFILE%\.dotnet\tools` on Windows, `~/.dotnet/tools` elsewhere) is not on the `PATH` of the process that launches the client. Restart the client, or use the full path as `command`.
- **An answer looks wrong or a control seems missing** — this is usually stale data in Infragistics' own NuGet package (summaries, base types) rather than a bug in this server. Cross-check against the pinned version above before assuming the MCP itself is at fault.

## Also available on npm

The same server, built from the same data, is published as [`@infragistics/wpf-mcp-server`](https://www.npmjs.com/package/@infragistics/wpf-mcp-server) for Node.js (`npx -y @infragistics/wpf-mcp-server`). Both packages return identical results.

## Links

- Source, issues and contributing: [github.com/Infragistics-Developer-Tools/wpf-mcp](https://github.com/Infragistics-Developer-Tools/wpf-mcp)
- MCP Registry: `io.github.Infragistics-Developer-Tools/wpf-mcp`
- License: MIT
