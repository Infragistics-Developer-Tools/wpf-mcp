# Development

How to build, test, release and publish `@infragistics/wpf-mcp-server` (npm) and `Infragistics.Wpf.Mcp` (NuGet). For what the server does and how to install it, see [README.md](README.md).

## Prerequisites

- **Node.js ≥ 20**
- **.NET 8 SDK** — `scripts/type-extractor` targets `net8.0-windows`, and the C# server in `server/` targets `net8.0`
- **Windows** — the type extractor loads the Infragistics WPF assemblies with real reflection, which needs the WindowsDesktop runtime. Everything else in the pipeline is portable, but you cannot produce `src/data/` on macOS/Linux
- Network access to **nuget.org** (Infragistics Trial packages) and **github.com** (three submodules)

## First build

```bash
git clone --recurse-submodules https://github.com/Infragistics-Developer-Tools/wpf-mcp.git
cd wpf-mcp
npm install
npm run build:all
```

`build:all` is `build:data` followed by `build`:

| Step | Script | Reads | Writes |
|---|---|---|---|
| NuGet restore | `docs:restore` | `nuget/WpfDocs.csproj` | `nuget/packages/` |
| Type extraction | `generate` → `scripts/generate.ts` → `dotnet run scripts/type-extractor` | `nuget/packages/**/*.dll` | `nuget/type-info.json` |
| API build | `generate` → `scripts/build-api.ts` | `nuget/packages/**/*.xml` + `type-info.json` | `src/data/api/*.json`, `namespaces.json`, `search-index.json` |
| Docs build | `build:docs` | `docs/docs-wpf`, `docs/docs-common` | `src/data/docs/*.json`, `docs-index.json` |
| Themes build | `build:themes` | `docs/wpf-resources` | `src/data/theme-resources/**`, `theme-index.json` |
| Build info | `build:info` | csproj + submodule SHAs | `src/data/build-info.json` |
| Compile | `build` | `src/` | `dist/` (with `src/data` copied to `dist/data`) |

The C# server is not part of `build:all`; once `src/data/` exists, `npm run build:dotnet` compiles it into `server/bin/Debug/net8.0/` with the data copied alongside.

First run takes 2–5 minutes, almost all of it the NuGet restore and the type extractor. Later runs are ~10 s: the restore is a no-op when `nuget/packages/` is populated, and `scripts/generate.ts` skips the extractor while `nuget/type-info.json` is newer than `nuget/WpfDocs.csproj` and everything in `scripts/type-extractor/` (`npx tsx scripts/generate.ts --force` to override).

A healthy build ends with these counts (they drift slightly between Infragistics versions):

```
Registry:     191 Xam* controls → src/data/namespaces.json
Search index: 6907 types → src/data/search-index.json
Topics written : 2678
theme-index.json: 8 newer themes, 45 legacy style folders, 822 XAML files total.
Build info → src/data/build-info.json
```

Every step validates its own output and aborts with a 🚨 banner (see `scripts/build-guard.ts`) if a submodule, package or index would come out empty. There is no "warning, continuing" mode — a degraded data set must never reach `dist/`.

**None of the generated data is committed.** `nuget/packages/`, `nuget/type-info.json`, `src/data/`, `dist/`, `server/bin|obj/` and `nupkg/` are all gitignored; the published package is regenerated from scratch by the publish workflow. What *is* committed — and therefore pins the content of a release — is the Infragistics version in `nuget/WpfDocs.csproj` and the three submodule commits.

### Submodules

`docs/docs-wpf`, `docs/docs-common` and `docs/wpf-resources` back the docs and theme tools. If you cloned without `--recurse-submodules`, `build:docs`/`build:themes` run `git submodule update --init --recursive` for you (via `scripts/ensure-submodules.ts`) and abort if that still leaves them empty. `npm run ensure-submodules` checks on its own.

### NuGet feed: private in CI, public by default locally

`nuget/WpfDocs.csproj` references the Trial packages. CI and the publish workflow restore `Infragistics.*` from the **Infragistics private feed** and everything else from nuget.org; the feed is configured from three repository secrets (see [CI reference](#ci-reference)). When the secrets are absent — on a pull request from a fork — the build falls back to nuget.org.

Locally, `npm run docs:restore` uses nuget.org unless a `nuget/nuget.config` exists (it is gitignored, so it never gets committed). To use the private feed on your machine, create it with the same shape CI generates — `%ENV%` placeholders are expanded by NuGet at restore time, so no credential is stored in the file:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="infragistics" value="https://your-private-feed/v3/index.json" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <infragistics>
      <add key="Username" value="%NUGET_FEED_USERNAME%" />
      <add key="ClearTextPassword" value="%NUGET_FEED_PASSWORD%" />
    </infragistics>
  </packageSourceCredentials>
  <packageSourceMapping>
    <packageSource key="infragistics">
      <package pattern="Infragistics.*" />
    </packageSource>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

Then set `NUGET_FEED_USERNAME` / `NUGET_FEED_PASSWORD` in your environment and run `npm run docs:restore`. For an offline folder feed, replace the `infragistics` URL with a local path and drop the `<packageSourceCredentials>` block. **Never commit a `nuget.config` containing real credentials** — the `.gitignore` entry is there so you don't have to think about it.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run build` | `tsc` + copy `src/data` → `dist/data`. Fails if `src/data/` doesn't exist yet |
| `npm run build:data` | Regenerate `src/data/` only (restore → extract → API → docs → themes → build info) |
| `npm run build:all` | `build:data` + `build` |
| `npm run dev` | Run `src/index.ts` with tsx (needs `src/data/`) |
| `npm test` | Smoke test: starts `dist/index.js` over stdio and calls every tool against the real data (`scripts/smoke-test.ts`) |
| `npm run build:dotnet` | `dotnet build` the C# server (`server/`) — copies `src/data` next to the binary, so it needs `src/data/` too |
| `npm run test:dotnet` | The same smoke test against the C# build (`smoke-test.ts --dotnet`) |
| `npm run test:parity` | Runs 60+ fixed tool calls against both servers and fails on any difference in instructions, tool descriptions/annotations, or output text (`scripts/parity-test.ts`) |
| `npm run pack:dotnet` | `dotnet pack` → `nupkg/Infragistics.Wpf.Mcp.<version>.nupkg`, version from `package.json` (`-- --version X.Y.Z` overrides) |
| `npm run typecheck` | `tsc --noEmit` for `src/` and `scripts/` — the only check that needs no data |
| `npm run validate:package` | Pre-publish gate: data-set thresholds, `dist/index.js` shebang, build-info ↔ csproj consistency, and — when `nupkg/` exists — the NuGet package's metadata, `.mcp/server.json` and data counts; `-- --expected-version X.Y.Z` also checks `package.json`, `server.json` and the nupkg version, and requires the nupkg |
| `npm run inspector` | MCP Inspector against `dist/index.js` |
| `node dist/index.js --debug` | Log every tool call to `wpf-mcp.log` in the system temp folder (`WPF_MCP_LOG` overrides the path); `dotnet server/bin/Debug/net8.0/wpf-mcp.dll --debug` does the same for the C# server |
| `npm run generate` / `build:docs` / `build:themes` / `build:info` | The individual `build:data` steps |
| `npm run generate:types` | The C# extractor alone |
| `npm run ensure-submodules` | Check/init the three submodules |
| `npm run docs:update` | Move the three submodules to their latest upstream commit |
| `npm pack --dry-run` | Show exactly what would be published to npm and how big it is (~12 MB tarball, ~100 MB unpacked, ~10k files); the nupkg from `pack:dotnet` is ~19 MB |

Before opening a PR: `npm run typecheck && npm run build:all && npm test && npm run build:dotnet && npm run test:dotnet && npm run test:parity && npm run pack:dotnet && npm run validate:package`. CI runs the same.

The C# server is a second runtime over the same `src/data/`, not a second product: `server/Program.cs` (bootstrap), `server/Data/` (models + loaders), `server/Tools/*.cs` (one class per tool group). Locally it builds as version `0.0.0-dev` (the placeholder in the csproj); `pack:dotnet` and CI override it with `-p:Version` from `package.json` or the release tag.

## Updating Infragistics data

The package content is a function of two committed pointers:

1. **NuGet version** — every `Version="…"` attribute in `nuget/WpfDocs.csproj` (all packages share one version).
2. **Submodule commits** — `docs/docs-wpf`, `docs/docs-common`, `docs/wpf-resources`.

To bump, either run the **Bump Infragistics data sources** workflow (Actions → *Bump Infragistics data sources* → *Run workflow*, enter the NuGet version and/or tick *update submodules*) which opens a PR, or do it by hand:

```bash
sed -i -E 's/(<PackageReference [^>]*Version=")[^"]+(")/\126.1.30\2/' nuget/WpfDocs.csproj
npm run docs:update
npm run build:all && npm test && npm run build:dotnet && npm run test:parity && npm run validate:package
git add nuget/WpfDocs.csproj docs/
git commit -m "chore(data): bump Infragistics sources (26.1.30)"
```

`validate:package` fails if `dist/data/build-info.json` was built from a different csproj version than the one checked in — it catches a forgotten rebuild.

> A PR opened by the workflow uses the default `GITHUB_TOKEN`, and GitHub never triggers other workflows from that token — so CI does not run on it automatically. Close and reopen the PR (or push an empty commit to its branch) to trigger CI before merging.

## Adding or changing a tool

Four TypeScript files, in this order:

1. `src/tools/constants.ts` — `TOOL_DESCRIPTIONS.<name>`; the descriptions cross-reference each other by tool name.
2. `src/tools/schemas.ts` — zod input schema; `.describe()` text is agent-facing guidance.
3. `src/tools/handlers.ts` — `create<Name>Handler(deps, log)` returning `async (input) => CallToolResult`. Every return path, including `isError: true`, must call `log(...)`.
4. `src/index.ts` — `server.registerTool(...)` with `readOnlyHint: true, idempotentHint: true, openWorldHint: false`, plus any new startup-loaded index.

Then the C# mirror — the parity test fails until it matches byte-for-byte:

5. `server/Tools/ToolDescriptions.cs` — the same description text as a raw string literal.
6. `server/Tools/<Group>Tools.cs` — a `[McpServerTool(Name = "...", ReadOnly = true, Idempotent = true, OpenWorld = false)]` method; `[Description]` on parameters is the zod `.describe()` text, `[MinLength]/[MaxLength]/[Range]` are the zod constraints (schema-only — clamp in code like the TS does), enums go in `server/Tools/Enums.cs`. Every return path calls `log.Write(...)`. A new tool class is registered with `.WithTools<T>()` in `server/Program.cs`; a new data file gets a record in `server/Data/Models.cs` (add it to `WpfJsonContext`) and a loader in `server/Data/DataStore.cs`.

Finally add a case to `scripts/smoke-test.ts`, a few calls (including error paths) to `CALLS` in `scripts/parity-test.ts`, and, if the tool reads a new file family, a threshold to `scripts/validate-package.ts`.

Porting gotchas that already bit once: JS `localeCompare` (use `NameComparer`), JS truthiness of `""` for optional strings, and line endings — C# raw string literals keep the source file's newlines, so `server/**/*.cs` is pinned to LF in `.gitattributes`; a CRLF checkout fails the parity test with lines that look identical.

Conventions:

- ESM with `module: Node16`: relative imports use `.js` extensions even for `.ts` sources.
- `ApiEntry`, `DocIndexEntry`/`DocEntry` and `ThemeIndex` are declared three times — in `scripts/*.ts` (producer), `src/lib/types.ts` (Node consumer) and `server/Data/Models.cs` (C# consumer). Scripts intentionally don't import from `src/`; change all three.
- Any on-demand file read goes through `resolveInside()` in `src/lib/safe-path.ts` (containment check, no character allowlist — generated names contain backticks, spaces and braces).
- A build step whose output count could legitimately be zero because of a missing upstream must `assertBuildStep(...)`, not warn.

## Versioning and release

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore(data):` …) — `CHANGELOG.md` is generated from them.

1. On `main`, bump:
   ```bash
   npm run release -- patch      # or minor | major | 1.2.3 | 1.2.0-beta.1
   ```
   This runs `npm version --no-git-tag-version`, whose `version` hook (`scripts/version.ts`) updates `package.json`, syncs `server.json` (top-level `version` and every `packages[].version` — the npm and the NuGet entry), and prepends the new section to `CHANGELOG.md`. Nothing is committed or tagged. The NuGet package takes its version from the release tag at pack time, so there is no third file to bump.
2. Review the diff, commit as `chore(release): 1.2.3`, open a PR, merge.
3. On GitHub, **Releases → Draft a new release**, tag = the **bare version** (`1.2.3`, no `v`) on the merge commit, generate notes, publish. Tick *pre-release* for `-alpha`/`-beta`/`-rc` versions.
4. The *Publish* workflow runs on release creation (see below). Watch it under Actions.

Prereleases publish under the npm `next` dist-tag and as a normal SemVer prerelease on nuget.org (no tag needed — `dotnet tool install` skips prereleases unless `--prerelease` is passed), and are **not** pushed to the MCP Registry (it has no dist-tag equivalent; publishing a beta there would make it the current version).

## CI reference

| Workflow | Trigger | Runner | Does |
|---|---|---|---|
| `nodejs.yml` — *Node.js CI* | push / PR to `main` | `typecheck`: ubuntu · `build-and-test`: windows, Node 22 + 24 | `npm ci` → `typecheck` → `build:all` → `test` → `build:dotnet` → `test:dotnet` → `test:parity` → `pack:dotnet` → `validate:package` → prints package sizes |
| `npm-publish.yml` — *Publish (npm + NuGet + MCP Registry)* | GitHub Release created | `build`: windows · three publish jobs: ubuntu | `build`: same as CI (nupkg stamped with the tag) + `validate:package --expected-version <tag>` + `npm pack` → two artifacts. `publish-npm`: `npm publish <tgz> --tag latest|next --provenance` via OIDC. `publish-nuget` (environment `nuget-org-publish`): `NuGet/login` + `dotnet nuget push`. `publish-mcp-registry` (non-prerelease only, after both): wait for nuget.org to index, `mcp-publisher publish` |
| `bump-infragistics.yml` — *Bump Infragistics data sources* | manual | ubuntu | Rewrites csproj versions and/or `docs:update`, opens a PR |

Both Windows jobs go through the composite action `.github/actions/build-data`, so CI and publish can't drift. It takes the private-feed credentials as inputs, which the workflows pass from these repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | Value |
|---|---|
| `NUGET_FEED_URL` | v3 index URL of the Infragistics private feed |
| `NUGET_FEED_USERNAME` | feed username |
| `NUGET_FEED_PASSWORD` | feed password / API key |

The action writes `nuget/nuget.config` from them (credentials as `%ENV%` placeholders, `Infragistics.*` mapped to the private feed, everything else to nuget.org) before restoring. Without the secrets it restores from nuget.org. No npm or nuget.org token exists: both registries use OIDC trusted publishing. `publish-nuget` additionally reads the secret `INFRAGISTICS_NUGET_ORG_USER` — the nuget.org account that owns the trust policy, passed to `NuGet/login` — and runs in the `nuget-org-publish` environment, both named the same way as in [IgniteUI/igniteui-blazor's release workflow](https://github.com/IgniteUI/igniteui-blazor/blob/master/.github/workflows/igniteui-blazor-lite-release.yml) so the nuget.org side can be configured identically.

It restores two caches:

| Cache | Key | Invalidated by |
|---|---|---|
| `nuget/packages` | `nuget-<os>-<hash of WpfDocs.csproj>` | NuGet version bump |
| `nuget/type-info.json` | `type-info-<os>-<hash of WpfDocs.csproj + scripts/type-extractor/**>` | NuGet version bump or extractor change |

With both hot, a full CI job is ~3 min (the C# build, tests and pack add about a minute); cold (first run after a bump) 5–8 min.

**Where to look when publish fails:** the `build` job's *Validate package contents* step prints one `OK`/error line per check — a version mismatch means the release tag doesn't match `package.json`/`server.json` (redo the bump), a threshold failure means the data pipeline produced less than expected (read the *Build data and server* step for the 🚨 banner), a `nupkg` error names what is wrong with the NuGet package. A *Parity test* failure prints the first differing line per call — the C# port has drifted from the TypeScript (or vice versa). The `publish` job failing at `npm publish` / `Get nuget.org API key` with an auth error means the trusted publisher isn't configured for this workflow on that registry (next section).

## First-time and manual publishing

Before the first workflow run, create the three `NUGET_FEED_*` repository secrets listed under [CI reference](#ci-reference).

Trusted publishing can only be configured on a package that already exists, so the first version is published by hand from a Windows machine:

```bash
npm login                                   # account must be a member of the @infragistics org
npm run build:all && npm test && npm run validate:package -- --expected-version 0.1.0
npm pack --dry-run                          # eyeball the file list once
npm publish --access public
```

Then on npmjs.com → package → *Settings* → *Trusted publisher* → GitHub Actions: repository `Infragistics-Developer-Tools/wpf-mcp`, workflow `npm-publish.yml`. From then on releases are published by the workflow without any token.

The MCP Registry namespace `io.github.Infragistics-Developer-Tools/*` is claimed automatically when `mcp-publisher login github-oidc` runs from this repository's Actions — nothing to configure. The registry verifies ownership by checking that the published npm package's `mcpName` field matches `server.json`'s `name`; keep both in sync (they are, unless one is edited by hand).

The same four commands are the fallback if Actions is unavailable; append `--tag next` to `npm publish` for a prerelease.

### NuGet

Unlike npm, a nuget.org trusted-publishing policy belongs to an **account**, not to a package, so the workflow can push the very first version — no manual push is needed. The setup mirrors [IgniteUI/igniteui-blazor](https://github.com/IgniteUI/igniteui-blazor/blob/master/.github/workflows/igniteui-blazor-lite-release.yml), which already publishes `IgniteUI.Blazor.Lite` this way from the Infragistics nuget.org account:

1. **Package ID prefix.** `Infragistics.*` is a [reserved prefix](https://learn.microsoft.com/nuget/nuget-org/id-prefix-reservation) owned by the Infragistics nuget.org account, so the trust policy must be created on that account (or on a co-owner of the prefix). The fallback is an unreserved ID: change `<PackageId>` in `server/Infragistics.Wpf.Mcp.csproj` and the nuget `identifier` in `server.json` (`validate:package` checks they agree).
2. **nuget.org** → that account → *Trusted Publishing* → add a policy: repository owner `Infragistics-Developer-Tools`, repository `wpf-mcp`, workflow file `npm-publish.yml`, environment `nuget-org-publish`.
3. **GitHub** → *Settings → Environments* → create `nuget-org-publish` (optionally with required reviewers — that makes every NuGet publish an approval step). *Settings → Secrets and variables → Actions* → secret `INFRAGISTICS_NUGET_ORG_USER` = the nuget.org username the policy was created under (an organization secret with that name already exists for IgniteUI repositories; this repository lives in another organization, so it has to be added here).

From then on `NuGet/login` mints a short-lived key per run. If Actions is unavailable, the manual path is:

```bash
npm run pack:dotnet -- --version 0.1.0 && npm run validate:package -- --expected-version 0.1.0
dotnet nuget push nupkg/*.nupkg --api-key <scoped key from nuget.org> --source https://api.nuget.org/v3/index.json
```

A version can never be pushed twice, so a rerun of the workflow for a tag that already published fails at `publish-nuget` (and at `publish-npm`) — that is intended.

The MCP Registry verifies NuGet ownership the same way it does npm: the nupkg must contain `.mcp/server.json` whose `name` matches the registry name. `pack:dotnet` copies the repository `server.json` there, and `validate:package` checks that the copy is current.

## Architecture notes

### Why reflection at build time

Infragistics WPF NuGet packages ship two files per assembly: `InfragisticsWPF.*.dll` and the compiler-generated `InfragisticsWPF.*.xml` doc comments. The XML gives summaries but no property types, enum values or inheritance; only reflection on the DLL does. So `scripts/type-extractor/Program.cs` loads every Infragistics DLL into one `AssemblyLoadContext`, walks all public types and writes `nuget/type-info.json` — a flat map of `"Type.Prop" → {typeName, isNullable, isEnum, enumValues}` plus `"Type.__baseType" → "Base"`. `scripts/build-api.ts` then merges that with the XML docs. No reflection happens at query time; a tool call is a JSON file read.

### build-api.ts specifics

- XML files are parsed with split-based chunking, not a regex over the whole multi-MB file, and members are bucketed into a `Map<typeFQN, members>` (O(n)).
- `enrichWithInheritance()` walks `__baseType` chains (cycle-guarded) and copies parent members onto children tagged with `declaredOn`. This is why `XamDataGrid` shows dozens of properties although it declares few directly.
- Types matching `EXCLUDE_SUFFIXES` / `EXCLUDE_CONTAINS` / `EXCLUDE_PACKAGES` are dropped, as are members whose summary is literally `internal`.
- When two types share a short name, the one documenting more members wins the file name; the others are listed in its `alternates`.
- `ASSEMBLY_XMLNS` maps assembly → xmlns URI/prefix; unlisted assemblies get `http://schemas.infragistics.com/xaml` / `ig`. `namespaces.json` contains only `Xam*`-prefixed types.

### Two runtimes, one data set

`src/` (TypeScript, published to npm) and `server/` (C#, published to NuGet) implement the same nine tools over the same generated `src/data/`. Neither is derived from the other — they are kept identical by `scripts/parity-test.ts`, which CI runs on every push. The C# server uses the official `ModelContextProtocol` SDK: tools are `[McpServerTool]` methods whose parameters become the input schema (DataAnnotations → JSON Schema constraints), models are records with a source-generated `JsonSerializerContext`, data files are `Content` items copied next to the binary (`Pack="false"`, so they travel inside the tool's `tools/net8.0/any/data/` folder rather than as NuGet content files). The nupkg also carries `PackageType` `McpServer` (nuget.org renders the MCP install snippet) and `.mcp/server.json`.

### Runtime data layout

| File | Size | Loaded | Purpose |
|---|---|---|---|
| `dist/data/namespaces.json` | ~50 KB | at startup | 191 Xam* control registry |
| `dist/data/search-index.json` | ~5 MB | at startup | compact index (`n,s,a,p,m` keys): name, summary, member names |
| `dist/data/docs-index.json` | ~1 MB | at startup | topic slugs, titles, control names, summaries |
| `dist/data/theme-index.json` | small | at startup | theme/style files with parsed `targetTypes` |
| `dist/data/build-info.json` | tiny | at startup | what the data was built from; printed to stderr |
| `dist/data/api/{Type}.json` | 5–15 KB each | on demand | full member details |
| `dist/data/docs/{slug}.json` | varies | on demand | full topic text + XAML snippets |
| `dist/data/theme-resources/**/*.xaml` | varies | on demand | raw theme resource dictionaries |

Search never touches the per-type files; `get_wpf_api_reference` reads exactly one.
