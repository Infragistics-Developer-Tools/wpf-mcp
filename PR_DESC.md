## Automate build and publish to npmjs

Sets up CI and release automation for `@infragistics/wpf-mcp-server`, modelled on [igniteui-cli](https://github.com/IgniteUI/igniteui-cli)'s process: publish on GitHub Release creation, OIDC trusted publishing (no npm token), `next`/`latest` dist-tags for prereleases, and MCP Registry publishing via `mcp-publisher`.

Generated data is **not** committed — the publish workflow regenerates it from the pinned NuGet version and submodule commits, restoring `Infragistics.*` from the private feed (`NUGET_FEED_*` secrets).

### Changes

- **Workflows** — `nodejs.yml` (CI: typecheck on ubuntu; full data build + smoke test + package validation on windows), `npm-publish.yml` (build/validate/pack on windows → publish tarball + MCP Registry on ubuntu), `bump-infragistics.yml` (manual: bump NuGet version / submodules, opens a PR). Shared composite action `.github/actions/build-data` with NuGet and type-info caches.
- **Package** — `mcpName`, `exports`, `publishConfig`, `files` whitelist, `.npmignore`, `server.json`; `prepublishOnly` removed; `engines` → Node ≥ 20.
- **Scripts** — `smoke-test.ts` (`npm test`, drives `dist/index.js` over stdio, 22 checks across all 9 tools), `validate-package.ts` (data thresholds + version consistency against the release tag), `version.ts` (`npm version` hook: syncs `server.json`, generates `CHANGELOG.md`), `generate.ts` (skips the C# extractor when `type-info.json` is fresh), `build-info.ts` (records Infragistics version + submodule SHAs; printed on startup).
- **Docs** — new `DEVELOPMENT.md` (build, data updates, release procedure, CI reference, first-time publish); `README.md` trimmed to consumer content with `npx` install; `CLAUDE.md` added.

### Before merging / first release

1. Create repository secrets `NUGET_FEED_URL`, `NUGET_FEED_USERNAME`, `NUGET_FEED_PASSWORD`.
2. Publish `0.1.0` manually once, then configure the trusted publisher on npmjs for `npm-publish.yml` (see `DEVELOPMENT.md` → *First-time and manual publishing*).


