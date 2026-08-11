import { describe, it, expect } from 'vitest';
import {
  createSetupWpfThemeHandler,
  createGetWpfThemeResourceHandler,
  createGetWpfThemePaletteHandler,
} from '../../src/tools/handlers.js';
import type { ThemeIndex } from '../../src/lib/types.js';
import { noopLog, textOf } from '../helpers/tool-result.js';

const themeIndex: ThemeIndex = {
  newerThemes: [
    {
      theme: 'MetroDark',
      files: [
        { path: 'Themes/MetroDark/MetroDark.xamDataChart.xaml', file: 'MetroDark.xamDataChart.xaml', targetTypes: ['XamDataChart', 'XamCategoryChart'] },
        { path: 'Themes/MetroDark/MetroDark.Theme.Colors.xaml', file: 'MetroDark.Theme.Colors.xaml', targetTypes: [] },
      ],
    },
    {
      theme: 'Office2013',
      files: [
        { path: 'Themes/Office2013/Office2013.xamDataChart.xaml', file: 'Office2013.xamDataChart.xaml', targetTypes: ['XamDataChart'] },
      ],
    },
  ],
  legacyStyles: [
    {
      folder: 'Ribbon',
      files: [
        { path: 'DefaultStyles/Ribbon/RibbonMetroDark.xaml', file: 'RibbonMetroDark.xaml', targetTypes: ['XamRibbon'] },
      ],
    },
  ],
};

describe('createSetupWpfThemeHandler', () => {
  it('browse mode (no args) lists every theme name and style folder', async () => {
    const handler = createSetupWpfThemeHandler(themeIndex, noopLog);
    const result = await handler({});
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/MetroDark/);
    expect(text).toMatch(/Office2013/);
    expect(text).toMatch(/Ribbon/);
  });

  it('filters by component across both families', async () => {
    const handler = createSetupWpfThemeHandler(themeIndex, noopLog);
    const result = await handler({ component: 'xamDataChart' });
    const text = textOf(result);
    expect(text).toMatch(/MetroDark\.xamDataChart\.xaml/);
    expect(text).toMatch(/Office2013\.xamDataChart\.xaml/);
    expect(text).not.toMatch(/RibbonMetroDark/);
  });

  it('filters by theme name', async () => {
    const handler = createSetupWpfThemeHandler(themeIndex, noopLog);
    const result = await handler({ theme: 'Office2013' });
    const text = textOf(result);
    expect(text).toMatch(/Office2013\.xamDataChart\.xaml/);
    expect(text).not.toMatch(/MetroDark\.xamDataChart\.xaml/);
  });

  it('combining component + theme narrows to exactly one file and calls it out', async () => {
    const handler = createSetupWpfThemeHandler(themeIndex, noopLog);
    const result = await handler({ component: 'xamDataChart', theme: 'MetroDark' });
    const text = textOf(result);
    expect(text).toMatch(/Exactly one file matched/);
    expect(text).toMatch(/Themes\/MetroDark\/MetroDark\.xamDataChart\.xaml/);
  });

  it('legacy family match surfaces the Theme="..." mechanism note only', async () => {
    const handler = createSetupWpfThemeHandler(themeIndex, noopLog);
    const result = await handler({ component: 'Ribbon' });
    const text = textOf(result);
    expect(text).toMatch(/Legacy family/);
    expect(text).not.toMatch(/ThemeManager\.ApplicationTheme = new/);
  });

  it('returns isError when no theme resources match the filters', async () => {
    const handler = createSetupWpfThemeHandler(themeIndex, noopLog);
    const result = await handler({ component: 'NoSuchComponentXyz' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No theme resource files matched/);
  });
});

describe('createGetWpfThemeResourceHandler', () => {
  it('returns isError with suggestions for an unknown path', async () => {
    const handler = createGetWpfThemeResourceHandler(themeIndex, noopLog, () => null);
    const result = await handler({ path: 'Themes/MetroDark/DoesNotExist.xaml' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found/);
  });

  it('rejects path traversal attempts as not found', async () => {
    const handler = createGetWpfThemeResourceHandler(themeIndex, noopLog, () => null);
    const result = await handler({ path: '../../../../etc/passwd' });
    expect(result.isError).toBe(true);
  });

  it('reads theme resource content via the injected loader', async () => {
    const fakeLoader = (path: string) => (path === 'Themes/MetroDark/MetroDark.xamDataChart.xaml' ? '<Style>fake xaml</Style>' : null);
    const handler = createGetWpfThemeResourceHandler(themeIndex, noopLog, fakeLoader);
    const result = await handler({ path: 'Themes/MetroDark/MetroDark.xamDataChart.xaml' });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toMatch(/```xml/);
    expect(text).toMatch(/fake xaml/);
    expect(text).toMatch(/Newer family: apply via/);
  });

  it('surfaces the legacy-family mechanism note for DefaultStyles paths', async () => {
    const fakeLoader = () => '<Style>legacy xaml</Style>';
    const handler = createGetWpfThemeResourceHandler(themeIndex, noopLog, fakeLoader);
    const result = await handler({ path: 'DefaultStyles/Ribbon/RibbonMetroDark.xaml' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/Legacy family: the named theme is already embedded/);
  });
});

describe('createGetWpfThemePaletteHandler', () => {
  it('chooser mode (no theme) lists only palette-capable themes', async () => {
    const handler = createGetWpfThemePaletteHandler(themeIndex, noopLog);
    const result = await handler({});
    const text = textOf(result);
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/MetroDark/);
    expect(text).not.toMatch(/- `Office2013`/);
  });

  it('returns isError for a theme with no palette file', async () => {
    const handler = createGetWpfThemePaletteHandler(themeIndex, noopLog);
    const result = await handler({ theme: 'Office2013' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No re-tunable palette found/);
  });

  it('parses a real palette file via the injected loader', async () => {
    const fixtureXaml = [
      '<!-- Base Colors -->',
      '<Color x:Key="Color_010">#E5FFFFFF</Color>  <!--90% White-->',
      '<SolidColorBrush x:Key="Brush01" Color="#FF00AADE" />',
    ].join('\n');
    const fakeLoader = (path: string) => (path === 'Themes/MetroDark/MetroDark.Theme.Colors.xaml' ? fixtureXaml : null);
    const handler = createGetWpfThemePaletteHandler(themeIndex, noopLog, fakeLoader);
    const result = await handler({ theme: 'MetroDark' });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toMatch(/WPF Theme Palette — MetroDark/);
    expect(text).toMatch(/Base Colors/);
    expect(text).toMatch(/Color_010/);
    expect(text).toMatch(/Brush01/);
  });

  it('filters palette entries and reports isError when the filter matches nothing', async () => {
    const fixtureXaml = '<SolidColorBrush x:Key="Brush01" Color="#FF00AADE" />';
    const fakeLoader = () => fixtureXaml;
    const handler = createGetWpfThemePaletteHandler(themeIndex, noopLog, fakeLoader);
    const result = await handler({ theme: 'MetroDark', filter: 'no-such-key' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no entries matched filter/);
  });
});

