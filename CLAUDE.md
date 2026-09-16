# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A stdio MCP server exposing 9 read-only tools over Infragistics NetAdvantage for WPF: component registry, API reference, keyword search, docs search, project scaffolding, and theming. It ships as two runtimes over one data set: TypeScript in `src/` (npm `@infragistics/wpf-mcp-server`) and C# in `server/` (NuGet `Infragistics.Wpf.Mcp`, a `dotnet tool`). All data is pre-generated at build time into `src/data/` (gitignored) and served from `dist/data/` / the tool's `data/` folder as plain JSON/XAML file reads — no reflection or network at runtime. The two runtimes must return byte-identical output; `scripts/parity-test.ts` enforces it.

## Commands

```bash
npm install
npm run build:all        # build:data + build: NuGet restore → C# type extractor → build-api → build-docs → build-themes → build-info → tsc
npm run build            # tsc only + copy src/data → dist/data. FAILS if src/data/ doesn't exist yet
npm run dev              # tsx src/index.ts (also needs src/data/ populated)
npm test                 # smoke test: drives dist/index.js over stdio, calls every tool (scripts/smoke-test.ts)
npm run build:dotnet     # dotnet build server/ (needs src/data/); npm run test:dotnet = smoke test against it
npm run test:parity      # 60+ fixed calls against both servers, fails on any output difference
npm run pack:dotnet      # dotnet pack → nupkg/ (version from package.json; -- --version X.Y.Z overrides)
npm run typecheck        # tsc --noEmit for src/ and scripts/ — needs no data
npm run validate:package # pre-publish gate: data thresholds + version consistency (-- --expected-version X.Y.Z)
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

Requirements: Node ≥ 20, .NET 8 SDK. The type extractor targets `net8.0-windows` with `UseWPF`, so `generate:types` only runs on Windows. Submodules `docs/docs-wpf`, `docs/docs-common`, `docs/wpf-resources` are auto-initialized by `build:docs`/`build:themes` via `scripts/ensure-submodules.ts`.

There is no unit-test suite or linter; `npm test`/`test:dotnet` are the stdio smoke tests, `test:parity` the cross-runtime diff, and `npm run validate:package` the data + nupkg gate. All run in CI and before publish.

Release/publish process (`npm run release -- <bump>` → PR → GitHub Release with bare tag → `npm-publish.yml`, which publishes npm + NuGet + MCP Registry), CI/cache layout, nuget.org trusted publishing, and data-source bumps are documented in `DEVELOPMENT.md` — read it before touching `.github/`, `server.json`, `server/*.csproj`, `scripts/version.ts` or `scripts/validate-package.ts`.

## Architecture

### Data pipeline (build time, `scripts/`)

- `nuget/WpfDocs.csproj` pins the Infragistics Trial package version (currently 26.1.21) and is the single place to bump it. `docs:restore` fills `nuget/packages/`.
- `scripts/type-extractor/Program.cs` loads every Infragistics DLL into one `AssemblyLoadContext` and writes `nuget/type-info.json` — a flat map of `"Type.Prop" → {typeName,isNullable,isEnum,enumValues}` plus `"Type.__baseType" → "Base"`. This is the only source of property types, enum values, and inheritance; XML docs alone give just summaries.
- `scripts/build-api.ts` parses the NuGet `*.xml` doc files (split-based chunking, not regex-over-whole-file, to avoid backtracking on multi-MB inputs), merges `type-info.json`, then `enrichWithInheritance()` walks `__baseType` chains (cycle-guarded) copying parent members onto children tagged with `declaredOn`. Types are filtered by `EXCLUDE_SUFFIXES`/`EXCLUDE_CONTAINS`/`EXCLUDE_PACKAGES`; members with summary `"internal"` are dropped. When two types share a short name, the one with more documented members wins and the rest are recorded in `alternates`. `ASSEMBLY_XMLNS` maps assembly → xmlns URI/prefix; anything unlisted gets `http://schemas.infragistics.com/xaml` / `ig`. `namespaces.json` is only `Xam*`-prefixed types. `TFM_PREF` and `byVersionDesc` pick one lib folder per package.
- `scripts/build-docs.ts` converts `.adoc` topics to `docs/{slug}.json` + `docs-index.json`. docs-common topics use `{PlaceholderName}` variables resolved from `docs-common/DocsConfig.xml` for the `wpf` product; only folders in `COMMON_INCLUDE` are taken from docs-common.
- `scripts/build-themes.ts` copies `Themes/` (newer ThemeManager family) and `DefaultStyles/` (legacy embedded-BAML `Theme="..."` family) XAML from wpf-resources and records per-file `targetTypes` parsed from `TargetType=` declarations — this is what makes "is component X themeable" lookups content-aware rather than filename-based.
- `scripts/build-guard.ts` `assertBuildStep()` is the fail-loud convention: any step whose output could be legitimately zero due to a missing upstream must assert instead of `console.warn`.

### Runtime (`src/`)

- `src/index.ts` — bootstrap: loads `namespaces.json`, `search-index.json`, `docs-index.json`, `theme-index.json` into memory once, defines the `--debug` logger, sets the server `instructions` (the canonical tool-calling workflow agents are told to follow), and registers each tool with `readOnlyHint/idempotentHint: true, openWorldHint: false`.
- `src/tools/constants.ts` — `TOOL_DESCRIPTIONS` (long, prompt-engineered; they cross-reference each other by tool name).
- `src/tools/schemas.ts` — zod input schemas; `.describe()` text is agent-facing guidance.
- `src/tools/handlers.ts` — one `create<Tool>Handler(deps, log)` factory per tool returning `async (input) => CallToolResult`. Every return path (including `isError: true`) calls `log(toolName, input, text, ms)`. Output is markdown text. Search tools use OR/ranked token matching (name hits weighted over member hits over summary hits).
- `src/lib/*-loader.ts` — on-demand reads of `dist/data/api/{Type}.json`, `docs/{slug}.json`, `theme-resources/**.xaml` with exact-then-case-insensitive lookup. All paths go through `resolveInside()` in `safe-path.ts` (containment check, no character allowlist, because generated names contain backticks/spaces/braces).
- `src/lib/types.ts` — runtime shapes. `SearchIndexEntry` uses single-letter keys (`n,s,a,p,m`) to keep the ~5MB index small.

### C# runtime (`server/`)

- `Program.cs` — same bootstrap as `src/index.ts` on the official `ModelContextProtocol` SDK: stderr-only logging, `--debug` file log, `ServerInstructions.cs` (verbatim copy of the instructions), `.WithTools<T>()` per tool class.
- `Data/Models.cs` (records + `WpfJsonContext` source-gen), `Data/DataStore.cs` (startup indexes, on-demand loaders, `ResolveInside` containment check), `Data/NameComparer.cs` (deterministic stand-in for JS `localeCompare`).
- `Tools/ComponentTools.cs`, `SearchTools.cs`, `DocsTools.cs`, `ThemeTools.cs` — one `[McpServerTool]` method per tool, `[Description]` = zod `.describe()`, DataAnnotations = zod constraints (schema-only; clamp in code). `Tools/ToolDescriptions.cs` mirrors `constants.ts`.
- Quirks are mirrored on purpose (JS `""` falsiness for optional strings) — see comments at each site. Change TS and C# together, then run `test:parity`.

### Conventions worth knowing

- ESM with `module: Node16` — relative imports must use `.js` extensions even for `.ts` sources.
- `ApiEntry`, `DocIndexEntry`/`DocEntry`, and `ThemeIndex` shapes exist three times: `scripts/*.ts` (producer), `src/lib/types.ts` (Node consumer) and `server/Data/Models.cs` (C# consumer; scripts intentionally don't import from `src/`). Change all three when changing the data shape.
- Adding a tool touches four TS files: `constants.ts` (description), `schemas.ts` (input), `handlers.ts` (factory), `index.ts` (registration + any new startup data) — plus its C# mirror in `server/Tools/`, a case in `scripts/smoke-test.ts` and calls in `scripts/parity-test.ts`.
- `nuget/type-info.json`, `nuget/packages/`, `src/data/`, `dist/`, `server/bin|obj/` and `nupkg/` are all gitignored build outputs — never commit them. The publish workflow regenerates them; what pins a release's content is `nuget/WpfDocs.csproj` + the submodule commits.
- `package.json` version and `server.json` version(s) must match — `scripts/version.ts` keeps them in sync; don't edit either by hand. The csproj has no real version (`0.0.0-dev`); `pack:dotnet`/CI inject it.
