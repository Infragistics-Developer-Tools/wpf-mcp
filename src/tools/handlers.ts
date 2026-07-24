import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadApiDoc } from '../lib/api-doc-loader.js';
import type { ComponentEntry, SearchIndexEntry } from '../lib/types.js';

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

    if (!hasAny) {      out.push(
        '',
        `_No ${kind === 'all' ? '' : kind + ' '}members defined directly on this type._`,
        '_Infragistics controls inherit most of their API from base classes. Call get_wpf_api_reference on the base class — e.g. XamDataPresenter for XamDataGrid._'
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

type SearchResult = { typeName: string; summary: string; nugetPackage: string; matchedOn: string };

export function createSearchApiHandler(index: SearchIndexEntry[], log: LogFn) {
  return async (input: { query: string; limit?: number }): Promise<CallToolResult> => {
    const start = performance.now();
    const tokens = input.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const limit = Math.min(input.limit ?? 10, 50);

    const nameMatches:    SearchResult[] = [];
    const summaryMatches: SearchResult[] = [];
    const memberMatches:  SearchResult[] = [];

    for (const entry of index) {
      const typeLower    = entry.n.toLowerCase();
      const summaryLower = entry.s.toLowerCase();
      const membersLower = entry.m.map(m => m.toLowerCase());

      // AND semantics: every token must appear somewhere in this entry
      const allMatch = tokens.every(t =>
        typeLower.includes(t) ||
        summaryLower.includes(t) ||
        membersLower.some(m => m.includes(t))
      );
      if (!allMatch) continue;

      if (tokens.every(t => typeLower.includes(t))) {
        nameMatches.push({ typeName: entry.n, summary: entry.s, nugetPackage: entry.p, matchedOn: 'name' });
      } else if (tokens.every(t => summaryLower.includes(t))) {
        summaryMatches.push({ typeName: entry.n, summary: entry.s, nugetPackage: entry.p, matchedOn: 'summary' });
      } else {
        const matchedMembers = [...new Set(
          tokens.flatMap(t => entry.m.filter(m => m.toLowerCase().includes(t)))
        )];
        memberMatches.push({
          typeName: entry.n,
          summary: entry.s,
          nugetPackage: entry.p,
          matchedOn: `members: ${matchedMembers.join(', ')}`,
        });
      }
    }

    const totalFound = nameMatches.length + summaryMatches.length + memberMatches.length;
    const results = [...nameMatches, ...summaryMatches, ...memberMatches].slice(0, limit);

    if (results.length === 0) {
      const hint = tokens.length > 1
        ? `It looks like you may be trying to verify specific members on a known type. Use get_wpf_api_reference("TypeName") instead — it returns the complete property, method, and event list so you can inspect it directly. Reserve search_wpf_api for discovery when you don't know the type name yet.`
        : `Try a shorter keyword or call list_wpf_components to browse available controls.`;
      const text = `No API entries found matching "${input.query}". ${hint}`;
      log('search_wpf_api', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const lines = results.map(r =>
      `### ${r.typeName}\n- **Matched:** ${r.matchedOn}\n- **NuGet:** \`${r.nugetPackage}\`\n- ${r.summary || '_(no summary)_'}`
    );

    const text = [
      `# WPF API Search: "${input.query}" (${results.length} of ${totalFound} matches)`,
      '',
      ...lines,
      '',
      `_Call \`get_wpf_api_reference\` with any type name above for full member details._`,
    ].join('\n\n');

    log('search_wpf_api', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}
