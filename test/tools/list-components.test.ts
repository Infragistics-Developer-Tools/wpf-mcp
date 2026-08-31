import { describe, it, expect } from 'vitest';
import { createListComponentsHandler } from '../../src/tools/handlers.js';
import type { ComponentEntry, ThemeIndex } from '../../src/lib/types.js';
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
  {
    component: 'XamDataChart',
    xamlNamespace: 'http://schemas.infragistics.com/xaml',
    defaultPrefix: 'ig',
    dotnetNamespace: 'Infragistics.Controls.Charts',
    nugetPackage: 'infragistics.wpf.charts.trial',
    assembly: 'Infragistics.WPF.Controls.Charts',
    description: 'A flexible charting control.',
  },
  {
    component: 'XamRibbon',
    xamlNamespace: 'http://schemas.infragistics.com/xaml',
    defaultPrefix: 'ig',
    dotnetNamespace: 'Infragistics.Windows.Ribbon',
    nugetPackage: 'infragistics.wpf.ribbon.trial',
    assembly: 'Infragistics.WPF.Ribbon',
    description: 'An Office-style ribbon control.',
  },
];

const themeIndex: ThemeIndex = {
  newerThemes: [],
  legacyStyles: [
    { folder: 'Ribbon', files: [{ path: 'DefaultStyles/Ribbon/RibbonMetroDark.xaml', file: 'RibbonMetroDark.xaml', targetTypes: ['XamRibbon'] }] },
  ],
};

describe('createListComponentsHandler', () => {
  it('returns every component when no filter is given', async () => {
    const handler = createListComponentsHandler(components, themeIndex, noopLog);
    const result = await handler({});
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/XamDataGrid/);
    expect(text).toMatch(/XamDataChart/);
    expect(text).toMatch(/XamRibbon/);
    expect(text).toMatch(/\(3 total\)/);
  });

  it('filters case-insensitively by component name', async () => {
    const handler = createListComponentsHandler(components, themeIndex, noopLog);
    const result = await handler({ filter: 'chart' });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/XamDataChart/);
    expect(text).not.toMatch(/XamDataGrid/);
    expect(text).not.toMatch(/XamRibbon/);
  });

  it('filters by nuget package name', async () => {
    const handler = createListComponentsHandler(components, themeIndex, noopLog);
    const result = await handler({ filter: 'ribbon.trial' });
    const text = textOf(result);
    expect(text).toMatch(/XamRibbon/);
    expect(text).not.toMatch(/XamDataGrid/);
  });

  it('returns isError with a helpful message when nothing matches', async () => {
    const handler = createListComponentsHandler(components, themeIndex, noopLog);
    const result = await handler({ filter: 'nonexistent-xyz' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No components found matching "nonexistent-xyz"/);
  });

  it('flags themeable components with a theming hint', async () => {
    const handler = createListComponentsHandler(components, themeIndex, noopLog);
    const result = await handler({ filter: 'ribbon' });
    const text = textOf(result);
    expect(text).toMatch(/setup_wpf_theme\(component: "XamRibbon"\)/);
  });

  it('does not flag non-themeable components', async () => {
    const handler = createListComponentsHandler(components, themeIndex, noopLog);
    const result = await handler({ filter: 'XamDataGrid' });
    const text = textOf(result);
    expect(text).not.toMatch(/setup_wpf_theme/);
  });
});
