#!/usr/bin/env tsx
/**
 * version.ts — `npm version` lifecycle hook (package.json "scripts.version").
 *
 * Runs after npm has bumped package.json, before it would commit. Keeps the rest of
 * the release metadata in step with that bump:
 *   server.json            top-level version + every packages[].version (MCP Registry)
 *   CHANGELOG.md           prepends a section from conventional commits since the last tag
 *
 * Invoked through `npm run release -- <patch|minor|major|1.2.3>`, which passes
 * --no-git-tag-version so nothing is committed or tagged; review the diff, commit,
 * and create the GitHub Release (tag = bare version) to publish.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const pkgJson    = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const serverPath = join(ROOT, 'server.json');
const serverJson = JSON.parse(readFileSync(serverPath, 'utf-8'));

const previous = serverJson.version;
serverJson.version = pkgJson.version;
for (const entry of serverJson.packages ?? []) entry.version = pkgJson.version;
writeFileSync(serverPath, JSON.stringify(serverJson, null, 2) + '\n');
console.log(`server.json: ${previous} → ${pkgJson.version}`);

execSync('npx conventional-changelog -p angular -i CHANGELOG.md -s', { cwd: ROOT, stdio: 'inherit' });
console.log(`CHANGELOG.md: added ${pkgJson.version}`);
