import { describe, it, expect } from 'vitest';
import { createGetApiReferenceHandler } from '../../src/tools/handlers.js';
import type { ComponentEntry, ThemeIndex, ApiEntry } from '../../src/lib/types.js';
import { noopLog, textOf } from '../helpers/tool-result.js';

const components: ComponentEntry[] = [
  {
    component: 'XamDataGrid',
    xamlNamespace: 'http://schemas.infragistics.com/xaml',
    defaultPrefix: 'ig',
    dotnetNamespace: 'Infragistics.Windows.DataPresenter',
    nugetPackage: 'infragistics.wpf.datagrids.trial',
    assembly: 'Infragistics.WPF.DataPresenter',
    description: 'A powerful data grid control.',
  },
];

const emptyThemeIndex: ThemeIndex = { newerThemes: [], legacyStyles: [] };

function makeApiEntry(overrides: Partial<ApiEntry> = {}): ApiEntry {
  return {
    component: 'XamDataGrid',
    assembly: 'Infragistics.WPF.DataPresenter',
    nugetPackage: 'infragistics.wpf.datagrids.trial',
    xamlNamespace: 'http://schemas.infragistics.com/xaml',
    defaultPrefix: 'ig',
    dotnetNamespace: 'Infragistics.Windows.DataPresenter',
    summary: 'A powerful data grid control.',
    remarks: '',
    properties: [{ name: 'DataSource', summary: 'The bound data source.', typeName: 'IEnumerable' }],
    events: [{ name: 'RecordActivated', summary: 'Fired when a record is activated.' }],
    methods: [{ name: 'SelectAll', summary: 'Selects all records.' }],
    ...overrides,
  };
}

describe('createGetApiReferenceHandler', () => {
  it('returns isError with known component names when the type is not found', async () => {
    const handler = createGetApiReferenceHandler(components, emptyThemeIndex, noopLog, () => null);
    const result = await handler({ component: 'ThisTypeDoesNotExistXyz', kind: 'all' });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/not found/);
    expect(text).toMatch(/XamDataGrid/);
  });

  it('returns full member listing for kind "all" via the injected loader', async () => {
    const handler = createGetApiReferenceHandler(components, emptyThemeIndex, noopLog, () => makeApiEntry());
    const result = await handler({ component: 'XamDataGrid', kind: 'all' });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toMatch(/^# XamDataGrid/m);
    expect(text).toMatch(/DataSource/);
    expect(text).toMatch(/RecordActivated/);
    expect(text).toMatch(/SelectAll/);
  });

  it('filters to only properties when kind is "properties"', async () => {
    const handler = createGetApiReferenceHandler(components, emptyThemeIndex, noopLog, () => makeApiEntry());
    const result = await handler({ component: 'XamDataGrid', kind: 'properties' });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/DataSource/);
    expect(text).not.toMatch(/## Methods/);
    expect(text).not.toMatch(/## Events/);
  });

  it('works with mixed-case component names when the loader resolves case-insensitively', async () => {
    const handler = createGetApiReferenceHandler(components, emptyThemeIndex, noopLog, (component) =>
      component.toLowerCase() === 'xamdatagrid' ? makeApiEntry() : null
    );
    const result = await handler({ component: 'xAmDaTaGrId', kind: 'all' });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/^# XamDataGrid/m);
  });

  it('adds a theming hint when the type has Brush properties and ships with named themes', async () => {
    const themeIndex: ThemeIndex = {
      newerThemes: [],
      legacyStyles: [{ folder: 'XamDataGrid', files: [{ path: 'DefaultStyles/XamDataGrid/MetroDark.xaml', file: 'MetroDark.xaml', targetTypes: ['XamDataGrid'] }] }],
    };
    const entry = makeApiEntry({ properties: [{ name: 'BackgroundBrush', summary: 'The background brush.', typeName: 'Brush' }] });
    const handler = createGetApiReferenceHandler(components, themeIndex, noopLog, () => entry);
    const result = await handler({ component: 'XamDataGrid', kind: 'all' });
    expect(textOf(result)).toMatch(/setup_wpf_theme\(component: "XamDataGrid"\)/);
  });

  it('names the base type when no members match the requested kind', async () => {
    const entry = makeApiEntry({ properties: [], events: [], methods: [], baseType: 'ContentControl' });
    const handler = createGetApiReferenceHandler(components, emptyThemeIndex, noopLog, () => entry);
    const result = await handler({ component: 'XamDataGrid', kind: 'all' });
    expect(textOf(result)).toMatch(/get_wpf_api_reference\("ContentControl"\)/);
  });
});

