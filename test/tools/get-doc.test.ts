import { describe, it, expect } from 'vitest';
import { createGetDocHandler } from '../../src/tools/handlers.js';
import type { DocIndexEntry, DocEntry } from '../../src/lib/types.js';
import { noopLog, textOf } from '../helpers/tool-result.js';

const docIndex: DocIndexEntry[] = [
  { slug: 'xamdatagrid-getting-started', title: 'Getting Started with XamDataGrid', controlNames: ['xamDataGrid'], tags: [], source: 'wpf', summary: '' },
];

function makeDocEntry(overrides: Partial<DocEntry> = {}): DocEntry {
  return {
    slug: 'xamdatagrid-getting-started',
    title: 'Getting Started with XamDataGrid',
    controlNames: ['xamDataGrid'],
    tags: ['Getting Started'],
    source: 'wpf',
    summary: 'Learn the basics of XamDataGrid.',
    body: 'Full topic body text describing how to get started.',
    xamlSnippets: ['<ig:XamDataGrid DataSource="{Binding Items}" />'],
    ...overrides,
  };
}

describe('createGetDocHandler', () => {
  it('returns isError with slug suggestions when the topic is not found', async () => {
    const handler = createGetDocHandler(docIndex, noopLog, () => null);
    const result = await handler({ topic: 'xamdatagrid-nonexistent-topic-xyz' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found/);
  });

  it('suggests a matching slug from the index when the topic is a partial match', async () => {
    const handler = createGetDocHandler(docIndex, noopLog, () => null);
    const result = await handler({ topic: 'xamdatagrid-getting' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Did you mean:/);
    expect(textOf(result)).toMatch(/xamdatagrid-getting-started/);
  });

  it('renders the full topic including XAML examples via the injected loader', async () => {
    const handler = createGetDocHandler(docIndex, noopLog, () => makeDocEntry());
    const result = await handler({ topic: 'xamdatagrid-getting-started' });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toMatch(/Topic slug:/);
    expect(text).toMatch(/XamDataGrid DataSource/);
    expect(text).toMatch(/Full topic body text/);
  });

  it('notes when a topic has no extracted XAML samples', async () => {
    const handler = createGetDocHandler(docIndex, noopLog, () => makeDocEntry({ xamlSnippets: [] }));
    const result = await handler({ topic: 'xamdatagrid-getting-started' });
    expect(textOf(result)).toMatch(/no extracted XAML code samples/);
  });
});

