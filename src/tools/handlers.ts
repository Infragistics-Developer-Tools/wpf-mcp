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

// ── search_wpf_api ────────────────────────────────────────────────────────────

type SearchResult = { typeName: string; summary: string; nugetPackage: string; matchedOn: string };

export function createSearchApiHandler(index: SearchIndexEntry[], log: LogFn) {
  return async (input: { query: string; limit?: number }): Promise<CallToolResult> => {
    const start = performance.now();
    const q = input.query.toLowerCase();
    const limit = Math.min(input.limit ?? 10, 50);

    const nameMatches:   SearchResult[] = [];
    const summaryMatches: SearchResult[] = [];
    const memberMatches:  SearchResult[] = [];
    const seen = new Set<string>();

    for (const entry of index) {
      const typeLower    = entry.n.toLowerCase();
      const summaryLower = entry.s.toLowerCase();

      if (typeLower.includes(q)) {
        nameMatches.push({ typeName: entry.n, summary: entry.s, nugetPackage: entry.p, matchedOn: 'name' });
        seen.add(entry.n);
        continue;
      }
      if (summaryLower.includes(q)) {
        summaryMatches.push({ typeName: entry.n, summary: entry.s, nugetPackage: entry.p, matchedOn: 'summary' });
        seen.add(entry.n);
        continue;
      }
      const matchedMember = entry.m.find(m => m.toLowerCase().includes(q));
      if (matchedMember) {
        memberMatches.push({ typeName: entry.n, summary: entry.s, nugetPackage: entry.p, matchedOn: `member: ${matchedMember}` });
        seen.add(entry.n);
      }
    }

    const results = [...nameMatches, ...summaryMatches, ...memberMatches].slice(0, limit);

    if (results.length === 0) {
      const text = `No API entries found matching "${input.query}". Try a shorter keyword or call list_wpf_components to browse available controls.`;
      log('search_wpf_api', input as Record<string, unknown>, text, Math.round(performance.now() - start));
      return { content: [{ type: 'text', text }], isError: true };
    }

    const lines = results.map(r =>
      `### ${r.typeName}\n- **Matched:** ${r.matchedOn}\n- **NuGet:** \`${r.nugetPackage}\`\n- ${r.summary || '_(no summary)_'}`
    );

    const text = [
      `# WPF API Search: "${input.query}" (${results.length} of ${seen.size + results.length} matches)`,
      '',
      ...lines,
      '',
      `_Call \`get_wpf_api_reference\` with any type name above for full member details._`,
    ].join('\n\n');

    log('search_wpf_api', input as Record<string, unknown>, text, Math.round(performance.now() - start));
    return { content: [{ type: 'text' as const, text }] };
  };
}
