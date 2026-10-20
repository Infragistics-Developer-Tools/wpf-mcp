# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A stdio MCP server exposing 9 read-only tools over Infragistics Ultimate UI for WPF: component registry, API reference, keyword search, docs search, project scaffolding, and theming. It has two runtimes over one data set: C# in `server/` (NuGet `Infragistics.Wpf.Mcp`, a `net10.0` `dotnet tool`, the only published package) and TypeScript in `src/` (npm packaging kept but no longer published). All data is pre-generated at build time into `src/data/` (gitignored) and served from `dist/data/` / the tool's `data/` folder as plain JSON/XAML file reads — no reflection or network at runtime. The TS server is frozen — don't edit `src/` — so new tools and behavior go into C# only and the two runtimes' output may differ (e.g. `get_wpf_api_reference` compaction and its `member` filter are C#-only). There is no parity contract or test any more.

## Commands

```bash
npm install
npm run build:all        # build:data + build: NuGet restore → C# type extractor → build-api → build-docs → build-themes → build-info → tsc
npm run build            # tsc only + copy src/data → dist/data. FAILS if src/data/ doesn't exist yet
npm run dev              # tsx src/index.ts (also needs src/data/ populated)
npm test                 # smoke test: drives dist/index.js over stdio, calls every tool (scripts/smoke-test.ts)
npm run build:dotnet     # dotnet build server/ (needs src/data/); npm run test:dotnet = smoke test against it
npm run pack:dotnet      # dotnet pack → nupkg/ (version from package.json; -- --version X.Y.Z overrides)
npm run typecheck        # tsc --noEmit for src/ and scripts/ — needs no data
npm run validate:package # pre-publish gate: data thresholds, nupkg contents (when nupkg/ exists), version consistency (-- --expected-version X.Y.Z)
npm run inspector        # MCP Inspector against dist/index.js
node dist/index.js --debug   # logs every tool call to $TMP/wpf-mcp.log (override: WPF_MCP_LOG)
```

Partial regeneration (each step validates its own output and aborts loudly on empty/missing input):

```bash
npm run build:data       # all of the below in order
npm run generate         # docs:restore + scripts/generate.ts (skips the C# extractor if type-info.json is fresh; --force) + build-api.ts
npm run generate:types   # C# reflection extractor only → nuget/type-info.json (gitignored)
npm run build:docs       # scripts/build-docs.ts → src/data/{docs-index.json,docs/}
npm run build:themes     # scripts/build-themes.ts → src/data/{theme-index.json,theme-resources/}
npm run build:info       # scripts/build-info.ts → src/data/build-info.json (Infragistics version, submodule SHAs)
npm run ensure-submodules
npm run docs:update      # pull latest for the 3 docs/theme submodules
```

Requirements: Node ≥ 20 and the .NET 10 SDK (pinned by `global.json`). The type extractor targets `net10.0-windows` with `UseWPF`, so `generate:types` only runs on Windows. Submodules `docs/docs-wpf`, `docs/docs-common`, `docs/wpf-resources` are auto-initialized by `build:docs`/`build:themes` via `scripts/ensure-submodules.ts`.

There is no unit-test suite or linter; `npm test`/`test:dotnet` are the stdio smoke tests (checks of C#-only behavior sit under `IS_DOTNET` in `scripts/smoke-test.ts`), and `npm run validate:package` the data + nupkg gate. All run in CI and before publish.

Release/publish process (`npm run release -- <bump>` → PR → GitHub Release with bare tag → `nuget-publish.yml` builds, signs and publishes the NuGet package, then lists non-prerelease versions in the MCP Registry), CI/cache layout, SHA-pinned actions, nuget.org trusted publishing, and data-source bumps are documented in `DEVELOPMENT.md` — read it before touching `.github/`, `server.json`, `server/*.csproj`, `scripts/version.ts` or `scripts/validate-package.ts`.

## Architecture

### Data pipeline (build time, `scripts/`)

- `nuget/WpfDocs.csproj` pins the Infragistics Trial package version (currently 26.1.21) and is the single place to bump it. `docs:restore` fills `nuget/packages/`.
- `scripts/type-extractor/Program.cs` loads every Infragistics DLL into one `AssemblyLoadContext` and writes `nuget/type-info.json` — a flat map of `"Type.Prop" → {typeName,isNullable,isEnum,enumValues}` (instance and static properties, plus static `ResourceKey`/`RoutedCommand` fields marked `isField`), `"__baseTypes"` (`"Assembly|Ns.Type" → "Assembly|Ns.Base"`, generic bases as their definition) and `"__xaml"` (`"Assembly|Ns.Type" → {xmlns, prefix, ns, xamlName?}`). The xmlns comes from System.Xaml's `XamlSchemaContext` over the DLLs' own `XmlnsDefinition`/`XmlnsPrefix` attributes — the most specific xmlns that resolves to exactly that type, else `clr-namespace:` syntax; nested types are `Outer+Inner`. This is the only source of property types, enum values, inheritance and xmlns; XML docs alone give just summaries.
- `scripts/build-api.ts` parses the NuGet `*.xml` doc files (split-based chunking, not regex-over-whole-file, to avoid backtracking on multi-MB inputs), merges `type-info.json` (its regex-parsed strings are JSON-unescaped: the extractor writes `` ` `` and `<` as ```/`<`), then `enrichWithInheritance()` walks the `__baseTypes` chains by assembly + full name (cycle-guarded, and only into the entry that IS that base, not a same-named type) copying parent members onto children tagged with `declaredOn`. Static key/command fields are listed with the properties (`isField`). Types are filtered by `EXCLUDE_SUFFIXES`/`EXCLUDE_CONTAINS`/`EXCLUDE_PACKAGES`; members with summary `"internal"` are dropped. When two types share a short name, the one with more documented members wins and the rest are recorded in `alternates`. Each type's `xamlNamespace`/`defaultPrefix` (and `xamlName` for nested types) come from `__xaml`; types it lacks (open generics, non-public types, DLLs left out of XAML resolution) fall back to `clr-namespace:`. `namespaces.json` is only `Xam*`-prefixed types. `TFM_PREF` and `byVersionDesc` pick one lib folder per package.
- `scripts/build-docs.ts` converts `.adoc` topics to `docs/{slug}.json` + `docs-index.json`. docs-common topics use `{PlaceholderName}` variables resolved from `docs-common/DocsConfig.xml` for the `wpf` product; only folders in `COMMON_INCLUDE` are taken from docs-common.
- `scripts/build-themes.ts` copies `Themes/` (newer ThemeManager family) and `DefaultStyles/` (legacy embedded-BAML `Theme="..."` family) XAML from wpf-resources and records per-file `targetTypes` parsed from `TargetType=` declarations — this is what makes "is component X themeable" lookups content-aware rather than filename-based.
- `scripts/build-guard.ts` `assertBuildStep()` is the fail-loud convention: any step whose output could be legitimately zero due to a missing upstream must assert instead of `console.warn`.

### Runtime (`src/`, frozen — not published, not edited; kept for reference and the TS smoke test)

- `src/index.ts` — bootstrap: loads `namespaces.json`, `search-index.json`, `docs-index.json`, `theme-index.json` into memory once, defines the `--debug` logger, sets the server `instructions` (the original of `server/ServerInstructions.cs`, which is now the canonical version), and registers each tool with `readOnlyHint/idempotentHint: true, openWorldHint: false`.
- `src/tools/constants.ts` — `TOOL_DESCRIPTIONS` (long, prompt-engineered; they cross-reference each other by tool name).
- `src/tools/schemas.ts` — zod input schemas; `.describe()` text is agent-facing guidance.
- `src/tools/handlers.ts` — one `create<Tool>Handler(deps, log)` factory per tool returning `async (input) => CallToolResult`. Every return path (including `isError: true`) calls `log(toolName, input, text, ms)`. Output is markdown text. Search tools use OR/ranked token matching (name hits weighted over member hits over summary hits).
- `src/lib/*-loader.ts` — on-demand reads of `dist/data/api/{Type}.json`, `docs/{slug}.json`, `theme-resources/**.xaml` with exact-then-case-insensitive lookup. All paths go through `resolveInside()` in `safe-path.ts` (containment check, no character allowlist, because generated names contain backticks/spaces/braces).
- `src/lib/types.ts` — runtime shapes. `SearchIndexEntry` uses single-letter keys (`n,s,a,p,m`) to keep the ~5MB index small.

### C# runtime (`server/`)

- `Program.cs` — same bootstrap as `src/index.ts` on the official `ModelContextProtocol` SDK: stderr-only logging, `--debug` file log, `ServerInstructions.cs` (the server instructions; started as a copy of the TS ones), `.WithTools<T>()` per tool class.
- `Data/Models.cs` (records + `WpfJsonContext` source-gen), `Data/DataStore.cs` (startup indexes, on-demand loaders, `ResolveInside` containment check), `Data/NameComparer.cs` (deterministic stand-in for JS `localeCompare`).
- `Tools/ComponentTools.cs`, `SearchTools.cs`, `DocsTools.cs`, `ThemeTools.cs` — one `[McpServerTool]` method per tool; parameter `[Description]`s are the agent-facing input guidance (originally ported from the zod `.describe()` text), DataAnnotations are schema-only constraints (the SDK doesn't enforce them; clamp/validate in code). `Tools/ToolDescriptions.cs` the tool descriptions (ported from `constants.ts`), `Tools/Enums.cs` the enum inputs, `Tools/ToolLog.cs` the `--debug` logger.
- `Infragistics.Wpf.Mcp.csproj` — `PackAsTool` + `PackageType McpServer`; `src/data/**` is a `Content` item with `Pack="false"` (it ships inside the tool folder, not as NuGet content), root `server.json` is packed as `.mcp/server.json`.
- Some JS quirks were ported on purpose (JS `""` falsiness for optional strings) — see comments at each site; keep them unless you mean to change agent-visible behavior.
- `server/**/*.cs` must stay LF (`.gitattributes` enforces it): raw string literals carry the file's line endings into descriptions/instructions, so a CRLF checkout would change the agent-facing text.

### Conventions worth knowing

- ESM with `module: Node16` — relative imports must use `.js` extensions even for `.ts` sources.
- `ApiEntry`, `DocIndexEntry`/`DocEntry`, and `ThemeIndex` shapes exist three times: `scripts/*.ts` (producer), `src/lib/types.ts` (Node consumer) and `server/Data/Models.cs` (C# consumer; scripts intentionally don't import from `src/`). Change the producer and `Models.cs` together. `src/lib/types.ts` is the one exception to "don't edit `src/`": additive fields need nothing there, but a breaking shape change must keep the TS server able to read the data, because CI still runs the TS smoke test against it.
- Adding or changing a tool is C#-only: `server/Tools/ToolDescriptions.cs` (description), the `[McpServerTool]` method in `server/Tools/` (+ `.WithTools<T>()` in `Program.cs` for a new class), and a case in `scripts/smoke-test.ts` under `IS_DOTNET` (the TS smoke test still runs in CI against the frozen TS server).
- `nuget/type-info.json`, `nuget/packages/`, `nuget/bin|obj/`, `src/data/`, `dist/`, `server/bin|obj/` and `nupkg/` are all gitignored build outputs — never commit them. The publish workflow regenerates them; what pins a release's content is `nuget/WpfDocs.csproj` + the submodule commits.
- `package.json` version and `server.json` version(s) must match — `scripts/version.ts` keeps them in sync; don't edit either by hand. The csproj has no real version (`0.0.0-dev`); `pack:dotnet`/CI inject it.
