import { describe, it, expect } from 'vitest';
import { createGetProjectScaffoldHandler } from '../../src/tools/handlers.js';
import type { ComponentEntry } from '../../src/lib/types.js';
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
];

describe('createGetProjectScaffoldHandler', () => {
  it('rejects an invalid project name', async () => {
    const handler = createGetProjectScaffoldHandler(components, noopLog);
    const result = await handler({ components: ['XamDataGrid'], projectName: '1Invalid Name!' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Invalid project name/);
  });

  it('errors when none of the requested components are found', async () => {
    const handler = createGetProjectScaffoldHandler(components, noopLog);
    const result = await handler({ components: ['XamNonexistentControl'] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/none of the requested components were found/);
  });

  it('generates a full scaffold for known components, matched case-insensitively', async () => {
    const handler = createGetProjectScaffoldHandler(components, noopLog);
    const result = await handler({ components: ['xamdatagrid'], projectName: 'MyApp', framework: 'net8.0' });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/dotnet new wpf -n MyApp --framework net8\.0/);
    expect(text).toMatch(/dotnet add package infragistics\.wpf\.datagrids\.trial/);
    expect(text).toMatch(/xmlns:ig="http:\/\/schemas\.infragistics\.com\/xaml"/);
  });

  it('warns about unresolved components but still scaffolds the resolved ones', async () => {
    const handler = createGetProjectScaffoldHandler(components, noopLog);
    const result = await handler({ components: ['XamDataGrid', 'XamNonexistent'] });
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/Warning:.*not found/s);
    expect(text).toMatch(/XamDataGrid/);
  });

  it('deduplicates repeated nuget packages/xmlns across multiple requested components', async () => {
    // Two distinct components sharing behavior would still list each xmlns/package once if identical;
    // here we assert each requested unique package appears exactly once.
    const handler = createGetProjectScaffoldHandler(components, noopLog);
    const result = await handler({ components: ['XamDataGrid', 'XamDataChart'] });
    const text = textOf(result);
    const gridPkgCount = (text.match(/dotnet add package infragistics\.wpf\.datagrids\.trial/g) ?? []).length;
    const chartPkgCount = (text.match(/dotnet add package infragistics\.wpf\.charts\.trial/g) ?? []).length;
    expect(gridPkgCount).toBe(1);
    expect(chartPkgCount).toBe(1);
  });

  it('defaults projectName and framework when omitted', async () => {
    const handler = createGetProjectScaffoldHandler(components, noopLog);
    const result = await handler({ components: ['XamDataGrid'] });
    const text = textOf(result);
    expect(text).toMatch(/dotnet new wpf -n MyWpfApp --framework net8\.0/);
  });
});
