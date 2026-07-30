import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadApiDoc } from '../lib/api-doc-loader.js';
import { loadDoc } from '../lib/docs-loader.js';
import { loadThemeResource } from '../lib/theme-loader.js';
import type { ComponentEntry, SearchIndexEntry, DocIndexEntry, ThemeIndex, ThemeResourceFile } from '../lib/types.js';

type LogFn = (tool: string, input: Record<string, unknown>, output: string, ms: number) => void;

// ── list_wpf_components ───────────────────────────────────────────────────────

export function createListComponentsHandler(components: ComponentEntry[], log: LogFn) {
  return async (input: { filter?: string }): Promise<CallToolResult> => {
    const start = performance.now();
    const { filter } = input;

    const matches = filter
      ? components.filter(c =>
          c.component.toLowerCase().includes(filter.toLowerCase()) ||
          c.description.toLowerCase().includes(filter.toLowerCase()) ||
          c.nugetPackage.toLowerCase().includes(filter.toLowerCase())
        )
      : components;

    if (matches.length === 0) {
      const text = `No components found matching "${filter}". Call list_wpf_components without a filter to see all ${components.length} available components.`;
      log('list_wpf_components', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const lines = matches.map(c => [
      `## ${c.component}`,
      `- **xmlns:** \`xmlns:${c.defaultPrefix}="${c.xamlNamespace}"\``,
      `- **NuGet:** \`${c.nugetPackage}\``,
      `- **Assembly:** \`${c.assembly}\``,
      `- ${c.description}`,
    ].join('\n'));

    const text = [
      `# Infragistics WPF Components (${matches.length}${filter ? ` matching "${filter}"` : ' total'})`,
      '',
      ...lines,
    ].join('\n\n');

    log('list_wpf_components', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── get_wpf_api_reference ─────────────────────────────────────────────────────

type ApiReferenceInput = { component: string; kind: 'all' | 'properties' | 'methods' | 'events' };

function formatMember(m: { name: string; summary: string; typeName?: string; isEnum?: boolean; enumValues?: string[] }): string {
  let line = `- **${m.name}**`;
  if (m.typeName) {
    line += ` \`${m.typeName}\``;
    if (m.isEnum && m.enumValues?.length) {
      line += ` — values: \`${m.enumValues.join('` | `')}\``;
    }
  }
  line += `: ${m.summary || '—'}`;
  return line;
}

export function createGetApiReferenceHandler(components: ComponentEntry[], log: LogFn) {
  return async (input: ApiReferenceInput): Promise<CallToolResult> => {
    const start = performance.now();
    const { component, kind } = input;

    // load from pre-generated api/{ComponentName}.json
    const doc = loadApiDoc(component);
    if (!doc) {
      const known = components.map(c => c.component).join(', ');
      const text = `Component "${component}" not found. Known Xam* controls: ${known}\n\nNote: Supporting types (FieldLayout, SummaryDefinition, etc.) are also available — use the exact type name.`;
      log('get_wpf_api_reference', input, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const allMembers = [
      ...doc.properties.map(m => ({ ...m, kind: 'property' as const })),
      ...doc.events.map(m => ({ ...m, kind: 'event' as const })),
      ...doc.methods.map(m => ({ ...m, kind: 'method' as const })),
    ];
    const KIND_SINGULAR: Record<string, string> = { properties: 'property', events: 'event', methods: 'method' };
    const members = kind === 'all' ? allMembers : allMembers.filter(m => m.kind === KIND_SINGULAR[kind]);

    const out: string[] = [
      `# ${doc.component}`,
      '',
      `**xmlns:** \`xmlns:${doc.defaultPrefix}="${doc.xamlNamespace}"\``,
      `**NuGet:** \`${doc.nugetPackage}\``,
      `**Assembly:** \`${doc.assembly}\``,
      '',
      '## Summary',
      doc.summary || '_(no summary)_',
    ];

    if (doc.remarks) out.push('', '## Remarks', doc.remarks);

    const grouped = {
      Properties: members.filter(m => m.kind === 'property'),
      Events:     members.filter(m => m.kind === 'event'),
      Methods:    members.filter(m => m.kind === 'method'),
    };

    let hasAny = false;
    for (const [label, items] of Object.entries(grouped)) {
      if (!items.length) continue;
      hasAny = true;

      // Group by declaredOn: direct first, then each ancestor
      const direct   = items.filter(m => !m.declaredOn);
      const inherited = new Map<string, Array<(typeof allMembers)[number]>>();
      for (const m of items.filter(m => m.declaredOn)) {
        const src = m.declaredOn!;
        if (!inherited.has(src)) inherited.set(src, []);
        inherited.get(src)!.push(m);
      }

      if (direct.length) {
        out.push('', `## ${label}`);
        direct.forEach(m => out.push(formatMember(m)));
      }
      for (const [src, srcItems] of inherited) {
        out.push('', `## ${label} (inherited from \`${src}\`)`);
        srcItems.forEach(m => out.push(formatMember(m)));
      }
    }

    if (!hasAny) {
      const baseHint = doc.baseType
        ? `Call get_wpf_api_reference("${doc.baseType}") to see the inherited API surface.`
        : `This type has no recorded base type in the registry — it may be a leaf/root type with no further members to inherit.`;
      out.push(
        '',
        `_No ${kind === 'all' ? '' : kind + ' '}members defined directly on this type._`,
        `_This type's own API surface is empty or was filtered by "kind". ${baseHint}_`
      );
    }

    const text = out.join('\n');
    log('get_wpf_api_reference', input, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── get_project_scaffold ─────────────────────────────────────────────────────

export function createGetProjectScaffoldHandler(components: ComponentEntry[], log: LogFn) {
  return async (input: { components: string[]; projectName?: string; framework?: string }): Promise<CallToolResult> => {
    const start = performance.now();
    const { components: requested, projectName = 'MyWpfApp', framework = 'net8.0' } = input;

    // Validate projectName — must be a safe .NET identifier
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(projectName)) {
      const text =
        `Invalid project name "${projectName}". ` +
        `Project names must start with a letter and contain only letters, digits, dots, underscores, or hyphens.`;
      log('get_project_scaffold', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const resolved: Array<{ component: string; nugetPackage: string; xmlns: string }> = [];
    const notFoundWarnings: string[] = [];

    for (const name of requested) {
      const entry = components.find(c => c.component.toLowerCase() === name.toLowerCase());
      if (!entry) {
        const suggestions = components
          .filter(c => c.component.toLowerCase().includes(name.toLowerCase()))
          .map(c => c.component)
          .slice(0, 5);
        const hint = suggestions.length > 0
          ? ` Did you mean: ${suggestions.map(s => `\`${s}\``).join(', ')}? ` +
            `Call \`list_wpf_components(filter: "${name}")\` to browse options.`
          : ` Call \`list_wpf_components\` to browse all available component names.`;
        notFoundWarnings.push(`\`${name}\` not found in registry.${hint}`);
      } else {
        resolved.push({
          component: entry.component,
          nugetPackage: entry.nugetPackage,
          xmlns: `xmlns:${entry.defaultPrefix}="${entry.xamlNamespace}"`,
        });
      }
    }

    if (resolved.length === 0) {
      const text =
        `Cannot generate scaffold — none of the requested components were found in the registry.\n\n` +
        notFoundWarnings.map(w => `- ${w}`).join('\n') +
        `\n\nCall \`list_wpf_components\` (with an optional filter keyword) to get exact component names, ` +
        `then call \`get_project_scaffold\` again with the correct names.`;
      log('get_project_scaffold', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const uniquePackages = [...new Set(resolved.map(r => r.nugetPackage))];
    const uniqueXmlns   = [...new Set(resolved.map(r => r.xmlns))];

    const lines: string[] = [];

    if (notFoundWarnings.length > 0) {
      lines.push(`> **Warning:** Some components were not found and were skipped:`);
      notFoundWarnings.forEach(w => lines.push(`> - ${w}`));
      lines.push('');
    }

    lines.push(`# WPF Project Scaffold: \`${projectName}\``);
    lines.push('');
    lines.push('## 1. Create and configure the project');
    lines.push('');
    lines.push('```bash');
    lines.push(`dotnet new wpf -n ${projectName} --framework ${framework}`);
    lines.push(`cd ${projectName}`);
    for (const pkg of uniquePackages) {
      lines.push(`dotnet add package ${pkg}`);
    }
    lines.push('dotnet restore');
    lines.push('```');
    lines.push('');
    lines.push('## 2. Add xmlns declarations to MainWindow.xaml');
    lines.push('');
    lines.push('```xml');
    lines.push('<Window ...');
    for (const xmlns of uniqueXmlns) {
      lines.push(`        ${xmlns}`);
    }
    lines.push('>');
    lines.push('```');

    lines.push('');
    lines.push('## Components resolved');
    for (const r of resolved) {
      lines.push(`- **${r.component}** → \`${r.nugetPackage}\``);
    }

    const text = lines.join('\n');
    log('get_project_scaffold', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── search_wpf_api ────────────────────────────────────────────────────────────

type SearchResult = { typeName: string; summary: string; nugetPackage: string; matchedOn: string; score: number };

export function createSearchApiHandler(index: SearchIndexEntry[], log: LogFn) {
  return async (input: { query: string; limit?: number }): Promise<CallToolResult> => {
    const start = performance.now();
    const tokens = input.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const limit = Math.min(input.limit ?? 10, 50);

    const results: SearchResult[] = [];

    for (const entry of index) {
      const typeLower    = entry.n.toLowerCase();
      const summaryLower = entry.s.toLowerCase();
      const membersLower = entry.m.map(m => m.toLowerCase());

      // Ranked/OR matching: a topic matching MORE tokens ranks higher, but matching
      // just one token is still a hit — a full-sentence query no longer returns nothing
      // just because one word isn't present anywhere in this entry.
      const nameHits    = tokens.filter(t => typeLower.includes(t)).length;
      const summaryHits = tokens.filter(t => summaryLower.includes(t)).length;
      const memberHits  = tokens.filter(t => membersLower.some(m => m.includes(t))).length;
      if (nameHits + summaryHits + memberHits === 0) continue;

      const matchedOn = nameHits > 0
        ? 'name'
        : memberHits > 0
          ? `members: ${[...new Set(tokens.flatMap(t => entry.m.filter(m => m.toLowerCase().includes(t))))].join(', ')}`
          : 'summary';

      // Name hits weighted highest, then members, then summary.
      const score = nameHits * 4 + memberHits * 2 + summaryHits;
      results.push({ typeName: entry.n, summary: entry.s, nugetPackage: entry.p, matchedOn, score });
    }

    results.sort((a, b) => b.score - a.score);
    const totalFound = results.length;
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      const hint = tokens.length > 1
        ? `It looks like you may be trying to verify specific members on a known type. Use get_wpf_api_reference("TypeName") instead — it returns the complete property, method, and event list so you can inspect it directly. Reserve search_wpf_api for discovery when you don't know the type name yet.`
        : `Try a different keyword or call list_wpf_components to browse available controls.`;
      const text = `No API entries found matching any word in "${input.query}". ${hint}`;
      log('search_wpf_api', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const lines = limited.map(r =>
      `### ${r.typeName}\n- **Matched:** ${r.matchedOn}\n- **NuGet:** \`${r.nugetPackage}\`\n- ${r.summary || '_(no summary)_'}`
    );

    const text = [
      `# WPF API Search: "${input.query}" (${limited.length} of ${totalFound} matches)`,
      '',
      ...lines,
      '',
      `_Call \`get_wpf_api_reference\` with any type name above for full member details._`,
    ].join('\n\n');

    log('search_wpf_api', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── search_wpf_docs ───────────────────────────────────────────────────────────

type DocSearchResult = DocIndexEntry & { matchedOn: string; score: number };

export function createSearchDocsHandler(docIndex: DocIndexEntry[], log: LogFn) {
  return async (input: { query?: string; control?: string; limit?: number }): Promise<CallToolResult> => {
    const start = performance.now();
    const tokens = (input.query ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    const controlFilter = input.control?.toLowerCase().trim();
    const limit = Math.min(input.limit ?? 10, 50);

    if (tokens.length === 0 && !controlFilter) {
      const text = `Provide at least one of \`query\` or \`control\`. Pass \`control\` alone to browse every topic for a component, or add \`query\` keywords to narrow further.`;
      log('search_wpf_docs', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    let controlMatchCount = 0;
    const results: DocSearchResult[] = [];

    for (const entry of docIndex) {
      // Hard pre-filter: if a control name was given, the topic must reference it
      if (controlFilter && !entry.controlNames.some(c => c.toLowerCase().includes(controlFilter))) {
        continue;
      }
      if (controlFilter) controlMatchCount++;

      if (tokens.length === 0) {
        // Browse mode: control filter alone, no keyword ranking needed.
        results.push({ ...entry, matchedOn: 'control name', score: 0 });
        continue;
      }

      const titleLower    = entry.title.toLowerCase();
      const controlsLower = entry.controlNames.join(' ').toLowerCase();
      const tagsLower      = entry.tags.join(' ').toLowerCase();
      const summaryLower   = entry.summary.toLowerCase();

      // Ranked/OR matching: a topic matching MORE tokens ranks higher, but matching
      // just one token is still a hit, so a longer natural-language query doesn't
      // return nothing just because one word isn't present anywhere in the entry.
      const titleHits   = tokens.filter(t => titleLower.includes(t)).length;
      const controlHits = tokens.filter(t => controlsLower.includes(t)).length;
      const tagHits      = tokens.filter(t => tagsLower.includes(t)).length;
      const summaryHits  = tokens.filter(t => summaryLower.includes(t)).length;
      if (titleHits + controlHits + tagHits + summaryHits === 0) continue;

      const matchedOn = titleHits > 0 ? 'title' : controlHits > 0 ? 'control name' : tagHits > 0 ? 'tags' : 'summary';
      const score = titleHits * 4 + controlHits * 3 + tagHits * 2 + summaryHits;
      results.push({ ...entry, matchedOn, score });
    }

    results.sort((a, b) => b.score - a.score);
    const totalFound = results.length;
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      let text: string;
      if (controlFilter && controlMatchCount === 0) {
        text = `No indexed topics reference control "${input.control}". Check the exact name with list_wpf_components — the control filter is a substring match, so a typo or wrong casing of the underlying name returns nothing.`;
      } else if (controlFilter) {
        text = `${controlMatchCount} topic(s) reference control "${input.control}", but none matched any word in "${input.query}". Try fewer/simpler keywords, or call search_wpf_docs(control: "${input.control}") with no query to browse all ${controlMatchCount} topics for this component.`;
      } else {
        text = `No documentation topics found matching any word in "${input.query}". Try shorter or more general keywords (e.g. "getting started", "grouping", "pin pane"), or add \`control\` to browse a specific component's topics directly.`;
      }
      log('search_wpf_docs', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const lines = limited.map(r => [
      `### ${r.title || r.slug}`,
      `- **Topic slug:** \`${r.slug}\``,
      `- **Matched on:** ${r.matchedOn}`,
      `- **Controls:** ${r.controlNames.length ? r.controlNames.join(', ') : '_(none listed)_'}`,
      `- **Tags:** ${r.tags.length ? r.tags.join(', ') : '_(none)_'}`,
      `- ${r.summary || '_(no summary)_'}`,
    ].join('\n'));

    const queryLabel = input.query ? `"${input.query}"` : '(browsing by control)';
    const text = [
      `# WPF Documentation Search: ${queryLabel} (${limited.length} of ${totalFound} matches)`,
      '',
      ...lines,
      '',
      `_Call \`get_wpf_doc\` with any topic slug above to retrieve the full text and XAML code samples._`,
    ].join('\n\n');

    log('search_wpf_docs', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── get_wpf_doc ───────────────────────────────────────────────────────────────

const MAX_BODY_CHARS    = 6000;
const MAX_SNIPPETS_SHOWN = 6;
const MAX_SNIPPET_CHARS  = 3000;

export function createGetDocHandler(docIndex: DocIndexEntry[], log: LogFn) {
  return async (input: { topic: string }): Promise<CallToolResult> => {
    const start = performance.now();
    const { topic } = input;

    const doc = loadDoc(topic);
    if (!doc) {
      const suggestions = docIndex
        .filter(e => e.slug.toLowerCase().includes(topic.toLowerCase()) || e.title.toLowerCase().includes(topic.toLowerCase()))
        .slice(0, 5)
        .map(e => `\`${e.slug}\``);
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ` Call \`search_wpf_docs\` with a keyword to find the correct topic slug.`;
      const text = `Documentation topic "${topic}" not found.${hint}`;
      log('get_wpf_doc', input, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const out: string[] = [
      `# ${doc.title || doc.slug}`,
      '',
      `**Topic slug:** \`${doc.slug}\``,
      `**Source:** ${doc.source === 'wpf' ? 'docs-wpf' : 'docs-common (shared cross-platform topic)'}`,
      `**Controls:** ${doc.controlNames.length ? doc.controlNames.join(', ') : '_(none listed)_'}`,
      `**Tags:** ${doc.tags.length ? doc.tags.join(', ') : '_(none)_'}`,
    ];

    if (doc.xamlSnippets.length > 0) {
      out.push('', '## XAML Examples');
      const shown = doc.xamlSnippets.slice(0, MAX_SNIPPETS_SHOWN);
      shown.forEach((snippet, i) => {
        const truncated = snippet.length > MAX_SNIPPET_CHARS;
        const text = truncated ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}\n<!-- truncated, ${snippet.length} chars total -->` : snippet;
        out.push('', `### Example ${i + 1}`, '```xml', text, '```');
      });
      const remaining = doc.xamlSnippets.length - shown.length;
      if (remaining > 0) out.push('', `_${remaining} additional XAML example(s) omitted for brevity._`);
    } else {
      out.push('', '_This topic has no extracted XAML code samples — see body text below for conceptual guidance._');
    }

    const bodyTruncated = doc.body.length > MAX_BODY_CHARS;
    const body = bodyTruncated ? `${doc.body.slice(0, MAX_BODY_CHARS)}\n\n_(truncated, ${doc.body.length} chars total)_` : doc.body;
    out.push('', '## Full Topic Text', '', body);

    const text = out.join('\n');
    log('get_wpf_doc', input, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── list_wpf_themes ───────────────────────────────────────────────────────────

const NEWER_MECHANISM_LINE =
  '_Newer family (`Themes/`): apply via `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` in App.xaml.cs (requires the `Infragistics.WPF.Themes.<Name>.Trial` NuGet package). Do NOT merge these files directly into `Application.Resources`._';

const LEGACY_MECHANISM_LINE =
  '_Legacy family (`DefaultStyles/`): the named theme is already embedded in the component\'s assembly — just set `Theme="<Name>"` on the control. Use these files only to copy/override individual Styles/ControlTemplates._';

const THEME_MECHANISM_GUIDE = [
  '## How to apply a theme',
  '',
  LEGACY_MECHANISM_LINE,
  '',
  NEWER_MECHANISM_LINE,
].join('\n');

function formatResourceFiles(files: ThemeResourceFile[], limit: number): string[] {
  const shown = files.slice(0, limit);
  const lines = shown.map(f => `  - \`${f.path}\``);
  const remaining = files.length - shown.length;
  if (remaining > 0) lines.push(`  - _...and ${remaining} more file(s) — narrow further with \`component\` and/or \`theme\` to see them_`);
  return lines;
}

export function createListWpfThemesHandler(themeIndex: ThemeIndex, log: LogFn) {
  return async (input: { component?: string; theme?: string }): Promise<CallToolResult> => {
    const start = performance.now();
    const { component, theme } = input;
    const componentFilter = component?.toLowerCase().trim();
    const themeFilter = theme?.toLowerCase().trim();

    const out: string[] = [];

    if (!componentFilter && !themeFilter) {
      // Browse mode — summarize everything available.
      out.push(`# Available WPF Themes`, '');
      out.push('## Newer family (ThemeManager) — theme names');
      themeIndex.newerThemes.forEach(t => out.push(`- **${t.theme}** (${t.files.length} file${t.files.length === 1 ? '' : 's'})`));
      out.push('', '## Legacy family (Theme="..." property) — style folders');
      themeIndex.legacyStyles.forEach(s => out.push(`- **${s.folder}** (${s.files.length} file${s.files.length === 1 ? '' : 's'})`));
      out.push('', THEME_MECHANISM_GUIDE);
      out.push('', '_Pass `component` and/or `theme` to filter down to exact file paths, then call get_wpf_theme_resource(path) to read one._');
      const text = out.join('\n');
      log('list_wpf_themes', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text' as const, text }] };
    }

    const matchedNewer = themeIndex.newerThemes
      .filter(t => !themeFilter || t.theme.toLowerCase().includes(themeFilter))
      .map(t => ({ theme: t.theme, files: t.files.filter(f => !componentFilter || f.file.toLowerCase().includes(componentFilter)) }))
      .filter(t => t.files.length > 0);

    const matchedLegacy = themeIndex.legacyStyles
      .map(s => {
        // `component` matches either the style folder (e.g. "Ribbon" → whole folder) or an
        // individual file name (e.g. "RibbonMetroDark" → that one file); `theme` matches file names.
        const folderMatchesComponent = !componentFilter || s.folder.toLowerCase().includes(componentFilter);
        const files = s.files.filter(f => {
          const nameLower = f.file.toLowerCase();
          const componentOk = folderMatchesComponent || nameLower.includes(componentFilter ?? '');
          const themeOk = !themeFilter || nameLower.includes(themeFilter);
          return componentOk && themeOk;
        });
        return { folder: s.folder, files };
      })
      .filter(s => s.files.length > 0);

    if (matchedNewer.length === 0 && matchedLegacy.length === 0) {
      const text = `No theme resource files matched component="${component ?? ''}" theme="${theme ?? ''}". Call list_wpf_themes with no arguments to browse all available theme names and style folders.`;
      log('list_wpf_themes', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const totalFiles =
      matchedNewer.reduce((n, t) => n + t.files.length, 0) +
      matchedLegacy.reduce((n, s) => n + s.files.length, 0);

    out.push(`# WPF Theme Resources${component ? ` — component: "${component}"` : ''}${theme ? ` — theme: "${theme}"` : ''} (${totalFiles} file${totalFiles === 1 ? '' : 's'})`);

    if (matchedNewer.length > 0) {
      out.push('', '## Newer family (ThemeManager)');
      for (const t of matchedNewer) {
        out.push('', `### ${t.theme}`, ...formatResourceFiles(t.files, 20));
      }
    }

    if (matchedLegacy.length > 0) {
      out.push('', '## Legacy family (Theme="..." property)');
      for (const s of matchedLegacy) {
        out.push('', `### ${s.folder}`, ...formatResourceFiles(s.files, 20));
      }
    }

    // Family-specific mechanism reminder (avoids dumping both mechanisms when only one is relevant).
    const mechanismLines: string[] = [];
    if (matchedLegacy.length > 0) mechanismLines.push(LEGACY_MECHANISM_LINE);
    if (matchedNewer.length > 0) mechanismLines.push(NEWER_MECHANISM_LINE);
    out.push('', ...mechanismLines);

    // If the filter narrowed to exactly one file, spell out the ready-to-use next call.
    if (totalFiles === 1) {
      const singlePath =
        matchedNewer[0]?.files[0]?.path ?? matchedLegacy[0]?.files[0]?.path ?? '';
      out.push('', `_Exactly one file matched — call \`get_wpf_theme_resource("${singlePath}")\` to read its XAML content._`);
    } else {
      out.push('', '_Call `get_wpf_theme_resource(path)` with any path above to read the full XAML content._');
    }

    const text = out.join('\n');
    log('list_wpf_themes', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}

// ── get_wpf_theme_resource ────────────────────────────────────────────────────

// Style files average ~60KB and can reach ~660KB; 8000 chars was well below one
// full ControlTemplate. 24000 fits ~5-6k tokens — room for real content while
// still capping the largest blobs.
const MAX_THEME_FILE_CHARS = 24000;

export function createGetWpfThemeResourceHandler(themeIndex: ThemeIndex, log: LogFn) {
  return async (input: { path: string }): Promise<CallToolResult> => {
    const start = performance.now();
    const { path } = input;

    const content = loadThemeResource(path);
    if (content === null) {
      const needle = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
      const allFiles = [
        ...themeIndex.newerThemes.flatMap(t => t.files),
        ...themeIndex.legacyStyles.flatMap(s => s.files),
      ];
      const suggestions = allFiles
        .filter(f => f.file.toLowerCase().includes(needle))
        .slice(0, 5)
        .map(f => `\`${f.path}\``);
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ` Call list_wpf_themes to browse available paths — never guess this path.`;
      const text = `Theme resource "${path}" not found.${hint}`;
      log('get_wpf_theme_resource', input, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const isNewerFamily = path.replace(/\\/g, '/').startsWith('Themes/');
    const mechanismNote = isNewerFamily
      ? '_Newer family: apply via `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` — do not merge this file directly into Application.Resources._'
      : '_Legacy family: the named theme is already embedded in the component assembly — set `Theme="..."` on the control. Use this file to copy/override specific styles only._';

    const truncated = content.length > MAX_THEME_FILE_CHARS;
    const shown = truncated ? `${content.slice(0, MAX_THEME_FILE_CHARS)}\n<!-- truncated, ${content.length} chars total -->` : content;

    const text = [
      `# ${path}`,
      '',
      mechanismNote,
      '',
      '```xml',
      shown,
      '```',
    ].join('\n');

    log('get_wpf_theme_resource', input, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}
