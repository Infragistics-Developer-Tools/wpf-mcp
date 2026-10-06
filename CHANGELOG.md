# [0.1.0-beta.0](https://github.com/Infragistics-Developer-Tools/wpf-mcp/compare/0.0.1-alpha.5...0.1.0-beta.0) (2026-10-06)


### Features
* **server:** first beta of the `Infragistics.Wpf.Mcp` dotnet tool — nine read-only MCP tools over Infragistics Ultimate UI for WPF 26.1.21: component registry, API reference (6,907 types), docs search (2,678 topics), project scaffolding and theming

### Bug Fixes
* **server:** starts even when the MCP client's working directory contains an unrelated or malformed `appsettings.json`
* **server:** `get_wpf_project_scaffold` rejects a project name with a trailing newline instead of emitting a broken `dotnet new` command
* **ci:** NuGet publish runs when a release is published, so a release saved as a draft first still publishes
* product renamed to Infragistics Ultimate UI for WPF; build-time type extractor moved to .NET 10

### Documentation
* install instructions state the .NET 10 SDK requirement and that the beta needs `--prerelease` or an exact version

## [0.0.1-alpha.5](https://github.com/Infragistics-Developer-Tools/wpf-mcp/compare/0.0.1-alpha.4...0.0.1-alpha.5) (2026-09-30)


### ⚠ BREAKING CHANGES

* **server:** the `Infragistics.Wpf.Mcp` dotnet tool now targets .NET 10 and requires the .NET 10 runtime or newer (was .NET 8, which reaches end of support on 2026-11-10)
* **npm:** the npm package is no longer published; `Infragistics.Wpf.Mcp` on NuGet is the only distribution

### Features

* **server:** the NuGet package is listed in the MCP Registry as `io.github.Infragistics-Developer-Tools/wpf-mcp` (stable versions only)
* **server:** the NuGet package includes `LICENSE` and `THIRD-PARTY-NOTICES.txt` for the bundled libraries
* **server:** package author and assembly metadata now read `Infragistics` / `Infragistics MCP Server for WPF`
* **server:** fewer bundled assemblies — .NET 10 provides the `System.*` libraries that .NET 8 lacked



## [0.0.1-alpha.4](https://github.com/Infragistics-Developer-Tools/wpf-mcp/compare/0.0.1-alpha.3...0.0.1-alpha.4) (2026-09-29)


### ⚠ BREAKING CHANGES

* **npm:** the npm package is renamed from `@infragistics/wpf-mcp-server` to `infragistics-wpf-mcp`; update `npx` / MCP client configurations accordingly

### Features

* **server:** Authenticode-sign `wpf-mcp.dll` and the `Infragistics.Wpf.Mcp` NuGet package ([7e7091a](https://github.com/Infragistics-Developer-Tools/wpf-mcp/commit/7e7091a9271aa5917c337b06b650cf8c391317d3))
* separate READMEs for the NuGet and npm packages ([77e1562](https://github.com/Infragistics-Developer-Tools/wpf-mcp/commit/77e156209382d97e94cd58a99e1237a592785f70))



## [0.0.1-alpha.3](https://github.com/Infragistics-Developer-Tools/wpf-mcp/compare/0.0.1-alpha.1...0.0.1-alpha.3) (2026-09-17)


### Features

* enforce LF line endings for C# files in .gitattributes to maintain parity with TypeScript ([27d6495](https://github.com/Infragistics-Developer-Tools/wpf-mcp/commit/27d649538878b982fa816e1b8d4114c56711bad6))
* **server:** add C# runtime published as NuGet dotnet tool ([726409d](https://github.com/Infragistics-Developer-Tools/wpf-mcp/commit/726409ddea109952fcbee84ad707e94381b7d9b2))
