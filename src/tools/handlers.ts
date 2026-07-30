import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadApiDoc } from '../lib/api-doc-loader.js';
import { loadDoc } from '../lib/docs-loader.js';
import type { ComponentEntry, SearchIndexEntry, DocIndexEntry } from '../lib/types.js';

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
      // Hard pre-filter: if a control name was given, the topic must reference it.
      // Bidirectional substring match handles docs that omit the "Xam" prefix in
      // their controlName metadata (e.g. "FinancialChart" vs "XamFinancialChart"):
      // either the stored name contains the filter, or the filter contains the stored name.
      // Hyphens are also normalised so "financial-chart" matches "XamFinancialChart".
      if (controlFilter && !entry.controlNames.some(c => {
        const cNorm = c.toLowerCase().replace(/-/g, '');
        const fNorm = controlFilter.replace(/-/g, '');
        return cNorm.includes(fNorm) || fNorm.includes(cNorm);
      })) {
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
