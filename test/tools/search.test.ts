import { describe, it, expect } from 'vitest';
import { createSearchApiHandler, createSearchDocsHandler } from '../../src/tools/handlers.js';
import type { SearchIndexEntry, DocIndexEntry } from '../../src/lib/types.js';
import { noopLog, textOf } from '../helpers/tool-result.js';

describe('createSearchApiHandler', () => {
  const searchIndex: SearchIndexEntry[] = [
    { n: 'XamDataGrid', s: 'A powerful data grid control.', a: 'Infragistics.WPF.DataPresenter', p: 'infragistics.wpf.datagrids.trial', m: ['DataSource', 'FieldLayouts', 'SortComparer'] },
    { n: 'FieldSettings', s: 'Settings that control editing behavior of a field.', a: 'Infragistics.WPF.DataPresenter', p: 'infragistics.wpf.datagrids.trial', m: ['AllowEdit', 'EditAsType', 'DataGridOwner'] },
    { n: 'XamDataChart', s: 'A flexible charting control.', a: 'Infragistics.WPF.Controls.Charts', p: 'infragistics.wpf.charts.trial', m: ['Series', 'Axes'] },
    { n: 'SeriesSettings', s: 'Configuration object for rendering behavior.', a: 'Infragistics.WPF.Controls.Charts', p: 'infragistics.wpf.charts.trial', m: ['SeriesType'] },
  ];

  it('ranks a name match above a members-only match', async () => {
    const handler = createSearchApiHandler(searchIndex, noopLog);
    const result = await handler({ query: 'DataGrid' });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    const nameMatchAt = text.indexOf('### XamDataGrid');
    const membersOnlyAt = text.indexOf('### FieldSettings');
    expect(nameMatchAt).toBeGreaterThan(-1);
    expect(membersOnlyAt).toBeGreaterThan(-1);
    expect(nameMatchAt).toBeLessThan(membersOnlyAt);
  });

  it('matches on member names', async () => {
    const handler = createSearchApiHandler(searchIndex, noopLog);
    const result = await handler({ query: 'AllowEdit' });
    const text = textOf(result);
    expect(text).toMatch(/FieldSettings/);
    expect(text).toMatch(/Matched:\*\* members: AllowEdit/);
  });

  it('OR-matches multi-word queries and ranks more-token matches first', async () => {
    const handler = createSearchApiHandler(searchIndex, noopLog);
    const result = await handler({ query: 'chart series' });
    const text = textOf(result);
    const chartAt = text.indexOf('### XamDataChart');
    const seriesSettingsAt = text.indexOf('### SeriesSettings');
    expect(chartAt).toBeGreaterThan(-1);
    expect(seriesSettingsAt).toBeGreaterThan(-1);
    expect(chartAt).toBeLessThan(seriesSettingsAt);
  });

  it('respects the limit parameter', async () => {
    const handler = createSearchApiHandler(searchIndex, noopLog);
    const result = await handler({ query: 'xam', limit: 1 });
    expect(textOf(result)).toMatch(/\(1 of \d+ matches\)/);
  });

  it('returns isError when nothing matches any token', async () => {
    const handler = createSearchApiHandler(searchIndex, noopLog);
    const result = await handler({ query: 'zzz-nonexistent-zzz' });
    expect(result.isError).toBe(true);
  });
});

describe('createSearchDocsHandler', () => {
  const docIndex: DocIndexEntry[] = [
    { slug: 'xamdatagrid-getting-started', title: 'Getting Started with XamDataGrid', controlNames: ['xamDataGrid'], tags: ['Getting Started'], source: 'wpf', summary: 'Learn the basics of XamDataGrid.' },
    { slug: 'xamdatagrid-grouping', title: 'Grouping Records', controlNames: ['xamDataGrid'], tags: ['How Do I'], source: 'wpf', summary: 'How to group records in the grid.' },
    { slug: 'xamdockmanager-getting-started', title: 'Getting Started with XamDockManager', controlNames: ['xamDockManager'], tags: ['Getting Started'], source: 'wpf', summary: 'Learn the basics of XamDockManager.' },
  ];

  it('requires at least one of query or control', async () => {
    const handler = createSearchDocsHandler(docIndex, noopLog);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Provide at least one of `query` or `control`/);
  });

  it('browses all topics for a control when query is omitted', async () => {
    const handler = createSearchDocsHandler(docIndex, noopLog);
    const result = await handler({ control: 'xamDataGrid' });
    const text = textOf(result);
    expect(text).toMatch(/Getting Started with XamDataGrid/);
    expect(text).toMatch(/Grouping Records/);
    expect(text).not.toMatch(/XamDockManager/);
  });

  it('normalizes hyphens/prefix when matching control names', async () => {
    const handler = createSearchDocsHandler(docIndex, noopLog);
    const result = await handler({ control: 'dock-manager' });
    expect(textOf(result)).toMatch(/Getting Started with XamDockManager/);
  });

  it('narrows by query within a control filter', async () => {
    const handler = createSearchDocsHandler(docIndex, noopLog);
    const result = await handler({ control: 'xamDataGrid', query: 'group' });
    const text = textOf(result);
    expect(text).toMatch(/Grouping Records/);
    expect(text).not.toMatch(/Getting Started with XamDataGrid/);
  });

  it('returns a control-specific isError message when the control has no topics at all', async () => {
    const handler = createSearchDocsHandler(docIndex, noopLog);
    const result = await handler({ control: 'xamRibbon' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No indexed topics reference control "xamRibbon"/);
  });

  it('returns a query-specific isError message when the control matches but the query does not', async () => {
    const handler = createSearchDocsHandler(docIndex, noopLog);
    const result = await handler({ control: 'xamDataGrid', query: 'zzz-nonexistent-zzz' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/but none matched any word/);
  });
});
