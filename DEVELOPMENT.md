# Development

How to build, test, release and publish `@infragistics/wpf-mcp-server`. For what the server does and how to install it, see [README.md](README.md).

## Prerequisites

- **Node.js ≥ 20**
- **.NET 8 SDK** — `scripts/type-extractor` targets `net8.0-windows`
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

**None of the generated data is committed.** `nuget/packages/`, `nuget/type-info.json`, `src/data/` and `dist/` are all gitignored; the published package is regenerated from scratch by the publish workflow. What *is* committed — and therefore pins the content of a release — is the Infragistics version in `nuget/WpfDocs.csproj` and the three submodule commits.

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
| `npm run typecheck` | `tsc --noEmit` for `src/` and `scripts/` — the only check that needs no data |
| `npm run validate:package` | Pre-publish gate: data-set thresholds, `dist/index.js` shebang, build-info ↔ csproj consistency; `-- --expected-version X.Y.Z` also checks `package.json` and `server.json` |
| `npm run inspector` | MCP Inspector against `dist/index.js` |
| `node dist/index.js --debug` | Log every tool call to `wpf-mcp.log` in the system temp folder (`WPF_MCP_LOG` overrides the path) |
| `npm run generate` / `build:docs` / `build:themes` / `build:info` | The individual `build:data` steps |
| `npm run generate:types` | The C# extractor alone |
| `npm run ensure-submodules` | Check/init the three submodules |
| `npm run docs:update` | Move the three submodules to their latest upstream commit |
| `npm pack --dry-run` | Show exactly what would be published and how big it is (~12 MB tarball, ~100 MB unpacked, ~10k files) |

Before opening a PR: `npm run typecheck && npm run build:all && npm test && npm run validate:package`. CI runs the same.

## Updating Infragistics data

The package content is a function of two committed pointers:

1. **NuGet version** — every `Version="…"` attribute in `nuget/WpfDocs.csproj` (all packages share one version).
2. **Submodule commits** — `docs/docs-wpf`, `docs/docs-common`, `docs/wpf-resources`.

To bump, either run the **Bump Infragistics data sources** workflow (Actions → *Bump Infragistics data sources* → *Run workflow*, enter the NuGet version and/or tick *update submodules*) which opens a PR, or do it by hand:

```bash
sed -i -E 's/(<PackageReference [^>]*Version=")[^"]+(")/\126.1.30\2/' nuget/WpfDocs.csproj
npm run docs:update
npm run build:all && npm test && npm run validate:package
git add nuget/WpfDocs.csproj docs/
git commit -m "chore(data): bump Infragistics sources (26.1.30)"
```

`validate:package` fails if `dist/data/build-info.json` was built from a different csproj version than the one checked in — it catches a forgotten rebuild.

> A PR opened by the workflow uses the default `GITHUB_TOKEN`, and GitHub never triggers other workflows from that token — so CI does not run on it automatically. Close and reopen the PR (or push an empty commit to its branch) to trigger CI before merging.

## Adding or changing a tool

Four files, in this order:

1. `src/tools/constants.ts` — `TOOL_DESCRIPTIONS.<name>`; the descriptions cross-reference each other by tool name.
2. `src/tools/schemas.ts` — zod input schema; `.describe()` text is agent-facing guidance.
3. `src/tools/handlers.ts` — `create<Name>Handler(deps, log)` returning `async (input) => CallToolResult`. Every return path, including `isError: true`, must call `log(...)`.
4. `src/index.ts` — `server.registerTool(...)` with `readOnlyHint: true, idempotentHint: true, openWorldHint: false`, plus any new startup-loaded index.

Then add a case to `scripts/smoke-test.ts` and, if the tool reads a new file family, a threshold to `scripts/validate-package.ts`.

Conventions:

- ESM with `module: Node16`: relative imports use `.js` extensions even for `.ts` sources.
- `ApiEntry`, `DocIndexEntry`/`DocEntry` and `ThemeIndex` are declared twice — in `scripts/*.ts` (producer) and `src/lib/types.ts` (consumer). Scripts intentionally don't import from `src/`; change both.
- Any on-demand file read goes through `resolveInside()` in `src/lib/safe-path.ts` (containment check, no character allowlist — generated names contain backticks, spaces and braces).
- A build step whose output count could legitimately be zero because of a missing upstream must `assertBuildStep(...)`, not warn.

## Versioning and release

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore(data):` …) — `CHANGELOG.md` is generated from them.

1. On `main`, bump:
   ```bash
   npm run release -- patch      # or minor | major | 1.2.3 | 1.2.0-beta.1
   ```
   This runs `npm version --no-git-tag-version`, whose `version` hook (`scripts/version.ts`) updates `package.json`, syncs `server.json` (top-level `version` and every `packages[].version`), and prepends the new section to `CHANGELOG.md`. Nothing is committed or tagged.
2. Review the diff, commit as `chore(release): 1.2.3`, open a PR, merge.
3. On GitHub, **Releases → Draft a new release**, tag = the **bare version** (`1.2.3`, no `v`) on the merge commit, generate notes, publish. Tick *pre-release* for `-alpha`/`-beta`/`-rc` versions.
4. The `Npm.js publish` workflow runs on release creation (see below). Watch it under Actions.

Prereleases publish under the npm `next` dist-tag and are **not** pushed to the MCP Registry (it has no dist-tag equivalent; publishing a beta there would make it the current version).

## CI reference

| Workflow | Trigger | Runner | Does |
|---|---|---|---|
| `nodejs.yml` — *Node.js CI* | push / PR to `main` | `typecheck`: ubuntu · `build-and-test`: windows, Node 22 + 24 | `npm ci` → `typecheck` → `build:all` → `test` → `validate:package` → prints pack size |
| `npm-publish.yml` — *Npm.js publish* | GitHub Release created | `build`: windows · `publish`: ubuntu | `build`: same as CI + `validate:package --expected-version <tag>` + `npm pack` → artifact. `publish`: `npm publish <tgz> --tag latest|next --provenance` via OIDC, then `mcp-publisher publish` (non-prerelease only) |
| `bump-infragistics.yml` — *Bump Infragistics data sources* | manual | ubuntu | Rewrites csproj versions and/or `docs:update`, opens a PR |

Both Windows jobs go through the composite action `.github/actions/build-data`, so CI and publish can't drift. It takes the private-feed credentials as inputs, which the workflows pass from these repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | Value |
|---|---|
| `NUGET_FEED_URL` | v3 index URL of the Infragistics private feed |
| `NUGET_FEED_USERNAME` | feed username |
| `NUGET_FEED_PASSWORD` | feed password / API key |

The action writes `nuget/nuget.config` from them (credentials as `%ENV%` placeholders, `Infragistics.*` mapped to the private feed, everything else to nuget.org) before restoring. Without the secrets it restores from nuget.org. No npm token exists: publishing uses OIDC trusted publishing.

It restores two caches:

| Cache | Key | Invalidated by |
|---|---|---|
| `nuget/packages` | `nuget-<os>-<hash of WpfDocs.csproj>` | NuGet version bump |
| `nuget/type-info.json` | `type-info-<os>-<hash of WpfDocs.csproj + scripts/type-extractor/**>` | NuGet version bump or extractor change |

With both hot, a full CI job is ~2 min; cold (first run after a bump) 5–8 min.

**Where to look when publish fails:** the `build` job's *Validate package contents* step prints one `OK`/error line per check — a version mismatch means the release tag doesn't match `package.json`/`server.json` (redo the bump), a threshold failure means the data pipeline produced less than expected (read the *Build data and server* step for the 🚨 banner). The `publish` job failing at `npm publish` with an auth error means the trusted publisher isn't configured for this workflow (next section).

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

## Architecture notes

### Why reflection at build time

Infragistics WPF NuGet packages ship two files per assembly: `InfragisticsWPF.*.dll` and the compiler-generated `InfragisticsWPF.*.xml` doc comments. The XML gives summaries but no property types, enum values or inheritance; only reflection on the DLL does. So `scripts/type-extractor/Program.cs` loads every Infragistics DLL into one `AssemblyLoadContext`, walks all public types and writes `nuget/type-info.json` — a flat map of `"Type.Prop" → {typeName, isNullable, isEnum, enumValues}` plus `"Type.__baseType" → "Base"`. `scripts/build-api.ts` then merges that with the XML docs. No reflection happens at query time; a tool call is a JSON file read.

### build-api.ts specifics

- XML files are parsed with split-based chunking, not a regex over the whole multi-MB file, and members are bucketed into a `Map<typeFQN, members>` (O(n)).
- `enrichWithInheritance()` walks `__baseType` chains (cycle-guarded) and copies parent members onto children tagged with `declaredOn`. This is why `XamDataGrid` shows dozens of properties although it declares few directly.
- Types matching `EXCLUDE_SUFFIXES` / `EXCLUDE_CONTAINS` / `EXCLUDE_PACKAGES` are dropped, as are members whose summary is literally `internal`.
- When two types share a short name, the one documenting more members wins the file name; the others are listed in its `alternates`.
- `ASSEMBLY_XMLNS` maps assembly → xmlns URI/prefix; unlisted assemblies get `http://schemas.infragistics.com/xaml` / `ig`. `namespaces.json` contains only `Xam*`-prefixed types.

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
