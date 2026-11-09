#!/usr/bin/env tsx
/**
 * smoke-test.ts
 *
 * Starts the built server (dist/index.js) over stdio exactly as an MCP client would,
 * then exercises every tool once against the real data set. This is the `npm test`
 * gate for CI and publishing: a build whose data is present but wrong (empty index,
 * missing inheritance, broken path guard) passes validate-package's counts but not this.
 *
 * Prerequisite: npm run build (dist/ must exist). Pass --dotnet (npm run test:dotnet) to run the
 * same checks against the C# server (dotnet build server/ first; WPF_MCP_DOTNET_DLL overrides the path).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dirname, '..');
const ENTRY = join(ROOT, 'dist', 'index.js');
const DOTNET_DLL = process.env.WPF_MCP_DOTNET_DLL ?? join(ROOT, 'server', 'bin', 'Debug', 'net10.0', 'wpf-mcp.dll');
const IS_DOTNET = process.argv.includes('--dotnet');
const TARGET = IS_DOTNET
  ? { entry: DOTNET_DLL, command: 'dotnet', args: [DOTNET_DLL], hint: 'dotnet build server/' }
  : { entry: ENTRY, command: process.execPath, args: [ENTRY], hint: 'npm run build' };
// Top-level heading of a tool response: the C# server uses `##` (clients render `#` as a page-sized
// title in their tool-result panes), the frozen TS server still uses `#`.
const H1 = IS_DOTNET ? '##' : '#';

const EXPECTED_TOOLS = [
  'list_wpf_components',
  'get_wpf_api_reference',
  'search_wpf_api',
  'get_wpf_project_scaffold',
  'search_wpf_docs',
  'get_wpf_doc',
  'setup_wpf_theme',
  'get_wpf_theme_resource',
  'get_wpf_theme_palette',
];

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let failures = 0;
const start = performance.now();

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function textOf(r: ToolResult): string {
  return r.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(TARGET.entry)) {
    console.error(`${TARGET.entry} not found — run ${TARGET.hint} first.`);
    process.exit(1);
  }

  const client = new Client({ name: 'wpf-mcp-smoke-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: TARGET.command, args: TARGET.args, stderr: 'pipe' });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));

  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  try {
    console.log('server');
    const info = client.getServerVersion();
    check('reports name/version', info?.name === 'infragistics-wpf' && !!info?.version, JSON.stringify(info));
    check('logs data build info on startup', /data: Infragistics \d+\.\d+\.\d+/.test(stderr.join('')), stderr.join('').trim() || '(no stderr yet)');

    console.log('tools/list');
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    check(`exposes exactly ${EXPECTED_TOOLS.length} tools`, JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), names.join(', '));
    check('every tool is read-only and idempotent',
      tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.idempotentHint === true && t.annotations?.openWorldHint === false));

    console.log('list_wpf_components');
    let r = await call('list_wpf_components', { filter: 'grid' });
    let text = textOf(r);
    check('filter "grid" finds XamDataGrid with its xmlns', !r.isError && text.includes('XamDataGrid') && text.includes('http://infragistics.com/DataPresenter'));
    // The xmlns comes from the DLL's own XmlnsDefinition per namespace, not one guess per assembly
    // (XamTabControl used to get http://schemas.infragistics.com/xaml, which doesn't compile).
    r = await call('list_wpf_components', { filter: 'XamTabControl' });
    check('XamTabControl gets the xmlns its DLL maps it to', !r.isError && textOf(r).includes('xmlns:igWindows="http://infragistics.com/Windows"'), textOf(r).slice(0, 300));
    // Internal classes are not indexed: the XML docs document them too, but no app can use them.
    r = await call('list_wpf_components', { filter: 'Funnel' });
    text = textOf(r);
    check('internal classes are not listed as controls', !r.isError && text.includes('XamFunnelChart') && !text.includes('XamFunnelController') && !text.includes('XamFunnelConnector'), text.slice(0, 300));
    // Types hidden from IntelliSense are Infragistics' own plumbing (the sparkline's drawing part), not controls to use.
    r = await call('list_wpf_components', { filter: 'Sparkline' });
    text = textOf(r);
    check('types hidden from IntelliSense are not listed as controls', !r.isError && text.includes('XamSparkline') && !text.includes('XamSparklineView'), text.slice(0, 300));

    console.log('get_wpf_api_reference');
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'all' });
    text = textOf(r);
    check('XamDataGrid resolves with xmlns and NuGet', !r.isError && text.startsWith(`${H1} XamDataGrid\n`) && text.includes('xmlns:igDP=') && text.includes('Infragistics.WPF'));
    check('inherited members are grouped by base type', text.includes('(inherited from `DataPresenterBase`)'), 'no "(inherited from `DataPresenterBase`)" section — enrichWithInheritance did not run');
    // kind: properties — small enough to render every member (inherited ones included) in full.
    r = await call('get_wpf_api_reference', { component: 'XamDataGrid', kind: 'properties' });
    check('property types and enum values are attached', /`[A-Za-z.]+` — values: `/.test(textOf(r)), 'no "`Type` — values: `…`" member line — type-info.json was not merged');
    // Theme classes: their xmlns is http://infragistics.com/Themes, and their static styles come from a generic base.
    r = await call('get_wpf_api_reference', { component: 'DataPresenterRoyalDark' });
    text = textOf(r);
    check('theme class gets the Themes xmlns and its inherited static styles',
      !r.isError && text.includes('xmlns:igThemes="http://infragistics.com/Themes"') && text.includes('**CellValuePresenter** `Style`') && text.includes('(inherited from `DataPresenterResourceSet`1`)'),
      text.slice(0, 400));
    // Static key/command fields are listed (they used to be dropped: DataPresenterCommands showed 0 of 71 commands).
    r = await call('get_wpf_api_reference', { component: 'DataPresenterCommands', kind: 'properties' });
    check('static command fields are listed', !r.isError && textOf(r).includes('**DeleteSelectedDataRecords** `RoutedCommand`'), textOf(r).slice(0, 300));
    // type-info strings are JSON-unescaped (generic type names used to reach agents as Action<ToolCommand>).
    // (C# compacts XamDataChart's inherited properties to names, so ask for the member itself there.)
    r = await call('get_wpf_api_reference', IS_DOTNET ? { component: 'XamDataChart', member: 'CommandCompleted' } : { component: 'XamDataChart', kind: 'properties' });
    check('generic type names are not JSON-escaped', !r.isError && textOf(r).includes('`Action<ToolCommand>`') && !/\\u00[0-9A-F]{2}/.test(textOf(r)));
    // Inheritance follows the exact base type: the chart Axis used to show members of the Excel library's ChartObject.
    r = await call('get_wpf_api_reference', { component: 'Axis', kind: 'properties' });
    check('chart Axis does not inherit from a same-named type', !r.isError && !textOf(r).includes('ChartObject'));
    // Internal classes have no page, and a name an internal class used to win now documents the public class.
    r = await call('get_wpf_api_reference', { component: 'ActivePaneManager' });
    check('internal class has no API page', r.isError === true, textOf(r).slice(0, 200));
    r = await call('get_wpf_api_reference', { component: 'XamSparklineView' });
    check('type hidden from IntelliSense has no API page', r.isError === true, textOf(r).slice(0, 200));
    r = await call('get_wpf_api_reference', { component: 'DashboardTileGroupDescription' });
    text = textOf(r);
    check('public type wins its name over an internal one',
      !r.isError && text.includes('`Infragistics.Controls.Dashboards.DashboardTileGroupDescription`') && !text.includes('.Implementation.'), text.slice(0, 400));
    // Members no app can call are not listed: internal ones (the XML docs document XamDockManager's internal
    // FlyoutOpening event) and explicit interface implementations ("System#Windows#Controls#Primitives#IScrollInfo#…").
    r = await call('get_wpf_api_reference', { component: 'XamDockManager', kind: 'events' });
    text = textOf(r);
    check('internal members are not listed', !r.isError && text.includes('**PaneDragStarting**') && !text.includes('FlyoutOpening'), text.slice(0, 300));
    r = await call('get_wpf_api_reference', { component: 'XamCarouselPanel', kind: 'properties' });
    check('explicit interface implementations are not listed', !r.isError && textOf(r).includes('# XamCarouselPanel') && !textOf(r).includes('IScrollInfo#'), textOf(r).slice(0, 300));
    // Member types are looked up per exact type: the XGrid FilterOperand's Icon (a String) used to overwrite XamGrid's.
    r = await call('get_wpf_api_reference', { component: 'DateTimeLastWeekFilterOperand', kind: 'properties' });
    check('member types come from the exact type, not a same-named one', !r.isError && textOf(r).includes('**Icon** `DataTemplate`'), textOf(r).slice(0, 300));
    // A base that lost its short name still passes its members on (XamGrid's Cell; the "Cell" page is the DataPresenter one).
    r = await call('get_wpf_api_reference', { component: 'AddNewRowCell', kind: 'properties' });
    text = textOf(r);
    check('members are inherited from a base whose name another type owns', !r.isError && text.includes('(inherited from `Cell`)') && text.includes('**IsEditing**'), text.slice(0, 300));
    // A type whose name another DLL's type also has under the same xmlns (XamDiagram's internal NodesManager) would fail
    // to compile with that xmlns, so it gets clr-namespace syntax naming its own assembly.
    r = await call('get_wpf_api_reference', { component: 'NodesManager' });
    check('a type shadowed under its xmlns gets clr-namespace with its assembly',
      !r.isError && textOf(r).includes('clr-namespace:Infragistics.Controls.Menus;assembly=Infragistics.WPF.Controls.Menus.XamDataTree'), textOf(r).slice(0, 300));
    if (IS_DOTNET) {
      // C# only: field label and nested-class XAML name are rendered by the C# server.
      r = await call('get_wpf_api_reference', { component: 'DataPresenterCommands', member: 'DeleteSelectedDataRecords' });
      check('static fields are labelled', !r.isError && textOf(r).includes('`RoutedCommand` _(static field)_'), textOf(r).slice(0, 400));
      r = await call('get_wpf_api_reference', { component: 'ActionBase' });
      check('nested classes show their XAML name', !r.isError && textOf(r).includes('**XAML name:** `igHelpers:ActionHistory+ActionBase`'), textOf(r).slice(0, 400));
    }
    if (IS_DOTNET) {
      // C# only: the TS server has no size guard / member filter.
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart' });
      text = textOf(r);
      check('large type is compacted under 25K chars', !r.isError && text.length <= 25_000 && text.includes('_ℹ️ Compacted:') && text.includes('(inherited from `XamXYChart`)\n`'), `${text.length} chars`);
      // Grids: events/methods go to names first, so the (mostly inherited) properties XAML needs keep full detail.
      for (const grid of ['XamDataGrid', 'XamTreeGrid']) {
        r = await call('get_wpf_api_reference', { component: grid });
        text = textOf(r);
        check(`${grid} compaction keeps full property detail`,
          !r.isError && text.length <= 25_000 && text.includes('events and methods are listed by name only') && /^- \*\*\w+\*\* `[A-Za-z.]+` — values: `/m.test(text),
          `${text.length} chars`);
      }
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'yaxis' });
      text = textOf(r);
      check('member filter returns inherited members in full detail',
        !r.isError && !text.includes('Compacted') && text.includes('(inherited from `XamXYChart`)') && text.includes('- **YAxisLabelLocation** `YAxisLabelLocation` — values: `') && !text.includes('**XAxisLabel**'),
        text.slice(0, 300));
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'NoSuchMemberXyz' });
      check('member filter with no match explains instead of erroring', !r.isError && textOf(r).includes('No members whose name contains "NoSuchMemberXyz"'));
      // A full member name must fit the limit: RibbonBrushKeys' static keys run to 74 characters.
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'x'.repeat(128) });
      check('member filter accepts 128 characters', !r.isError && textOf(r).includes('No members whose name contains'), textOf(r).slice(0, 200));
      r = await call('get_wpf_api_reference', { component: 'XamCategoryChart', member: 'x'.repeat(129) });
      check('member over 128 characters → isError naming the limit', r.isError === true && textOf(r).includes('max 128 characters'), textOf(r).slice(0, 200));
      // Methods carry their C# signature, one line per overload; with `member`, also the parameter descriptions,
      // which tell overloads with the same summary apart ("XPS only" is what an agent needs before trying PDF).
      r = await call('get_wpf_api_reference', { component: 'Report', member: 'Export' });
      text = textOf(r);
      check('overloads show their signatures and parameter descriptions',
        !r.isError && text.includes('- `void Export(OutputFormat outputFormat, string fileName)`:') && text.includes('  - `outputFormat`: The output document type (XPS only).'),
        text.slice(0, 400));
      // Constructors that take parameters are listed; [Obsolete] ones only come back as a notice.
      r = await call('get_wpf_api_reference', { component: 'Workbook', member: 'Workbook' });
      text = textOf(r);
      check('constructors are listed, obsolete ones as a notice',
        !r.isError && text.includes('### Constructors\n- `Workbook(WorkbookFormat format)`:') && text.includes('⚠ OBSOLETE constructor `Workbook(WorkbookPaletteMode paletteMode)`'),
        text.slice(0, 400));
      // An [Obsolete] member isn't listed, but looking it up gets the replacement (8 docs topics still set HorizontalZoomable).
      r = await call('get_wpf_api_reference', { component: 'XamDataChart', member: 'HorizontalZoomable' });
      text = textOf(r);
      check('obsolete member lookup names the replacement',
        !r.isError && text.includes('⚠ OBSOLETE property `XamDataChart.HorizontalZoomable`: Please use the IsHorizontalZoomEnabled property.') && !text.includes('**HorizontalZoomable**'),
        text.slice(0, 400));
      // An [Obsolete] type keeps its page but leads with the replacement (3 docs topics still use UnboundField).
      r = await call('get_wpf_api_reference', { component: 'UnboundField', kind: 'events' });
      check('obsolete type page leads with the replacement', !r.isError && textOf(r).includes('⚠ **OBSOLETE type:** Use Field'), textOf(r).slice(0, 300));
      // Obsolete member names stay searchable, so an agent following old docs still finds the type and its note.
      r = await call('search_wpf_api', { query: 'HorizontalZoomable', limit: 3 });
      check('obsolete member names stay searchable', !r.isError && textOf(r).includes('XamDataChart'), textOf(r).slice(0, 300));
      // Compacted lists name an overloaded method once, with its count.
      r = await call('get_wpf_api_reference', { component: 'XamDataGrid' });
      check('compacted lists show an overloaded method once with its count', !r.isError && textOf(r).includes('`LoadCustomizations` (8)'), textOf(r).slice(0, 200));
      // An override of a generic base type's method replaces it: CollectionBase<T>.Insert(int, T) isn't listed again.
      r = await call('get_wpf_api_reference', { component: 'ColumnBaseCollection', member: 'Insert' });
      text = textOf(r);
      check('an override of a generic base method is listed once',
        !r.isError && text.includes('- `void Insert(int index, ColumnBase item)`:') && !text.includes('void Insert(int index, T item)'),
        text.slice(0, 400));
      // A member a subtype re-declares hidden from IntelliSense isn't inherited from the base either.
      r = await call('get_wpf_api_reference', { component: 'TemplateColumn', member: 'ValueConverter' });
      check('a member hidden on the subtype is not inherited from the base',
        !r.isError && textOf(r).includes('No members whose name contains "ValueConverter"'), textOf(r).slice(0, 400));
      // Nullable<T> properties keep their "?" (CurrentViewDateRange used to read `DateRange`).
      r = await call('get_wpf_api_reference', { component: 'XamOutlookCalendarView', member: 'CurrentViewDateRange' });
      check('nullable property types end in "?"', !r.isError && textOf(r).includes('- **CurrentViewDateRange** `DateRange?`:'), textOf(r).slice(-400));
      // Protected properties and events look public in the XML docs: they get their type and a marker (an agent used
      // XamGrid.CurrentEditCell from outside the grid and got CS0122). Public ones aren't marked.
      r = await call('get_wpf_api_reference', { component: 'XamGrid', member: 'Cell' });
      text = textOf(r);
      check('protected properties show their type, marked protected',
        !r.isError && text.includes('- **CurrentEditCell** `Cell` _(protected)_:') && text.includes('- **ActiveCell** `CellBase`:'), text.slice(0, 400));
      r = await call('get_wpf_api_reference', { component: 'XamDataTree', kind: 'events', member: 'NodeDelet' });
      check('protected events are marked protected', !r.isError && textOf(r).includes('- **NodeDeleting** _(protected)_:'), textOf(r).slice(-400));
      // A list of names keeps them apart too, after "protected:".
      r = await call('get_wpf_api_reference', { component: 'XamDataChart' });
      check('compacted lists name protected members after "protected:"',
        !r.isError && /^`CommandCompleted`, [^\n]*; protected: `IsHighlightingInitialized`, /m.test(textOf(r)), textOf(r).slice(0, 300));
      // A method name goes there when all its overloads are protected (InvalidateScrollPanel, 3 of them); one with a public
      // overload stays public, its count unchanged (Dispose(): public, Dispose(bool): protected).
      r = await call('get_wpf_api_reference', { component: 'XamGrid' });
      const xamGridMethods = /^### Methods\n(.*)$/m.exec(textOf(r))?.[1] ?? '';
      check('compacted method lists name protected-only methods after "protected:"',
        !r.isError && /^`OnApplyTemplate`, [^;]*`Dispose` \(2\); protected: `OnCreateAutomationPeer`, [^;]*`InvalidateScrollPanel` \(3\)/.test(xamGridMethods),
        xamGridMethods.slice(0, 300));
      // Protected ones go to names before public ones lose detail: in full, their types and markers take this kind "properties"
      // response to 25.3K, over 25K, and with it every inherited property down to its name (23.0K with them by name).
      r = await call('get_wpf_api_reference', { component: 'GeographicHighDensityScatterSeries', kind: 'properties' });
      text = textOf(r);
      check('protected properties go to names before public ones',
        !r.isError && text.length <= 25_000 && text.includes('so protected properties and events are listed by name only (public members keep full detail)') &&
        text.includes('- **DataLegendGroup** `String`:') && text.includes('\n- protected: `CustomClipRect`, '),
        `${text.length} chars`);
      // Enums list their values (894 enum pages said "No members defined directly on this type"), with any kind.
      r = await call('get_wpf_api_reference', { component: 'OutputFormat', kind: 'properties' });
      text = textOf(r);
      check('an enum lists its values', !r.isError && text.includes('### Values\n- **XPS** = 0: Exports to XPS format') && !text.includes('No properties members'), text.slice(-400));
      r = await call('get_wpf_api_reference', { component: 'ValueConstraintFlags' });
      text = textOf(r);
      check('a [Flags] enum says its values combine',
        !r.isError && text.includes('_[Flags] enum: values combine — `ValueConstraintFlags.Enumeration | ValueConstraintFlags.FixedValue` in C#') && text.includes('- **All** = 2147483647:'),
        text.slice(-600));
      // Without two single-bit values of its own (None, Office2007UI, All) there is no example, not a made-up `A | B`.
      r = await call('get_wpf_api_reference', { component: 'LicenseOptions' });
      text = textOf(r);
      check('a [Flags] enum with one single-bit value has no placeholder example',
        !r.isError && text.includes('_[Flags] enum: values combine with `|` in C#, comma-separated in a XAML attribute._') && !/LicenseOptions\.\w+ \| /.test(text),
        text.slice(-400));
      // An [Obsolete] value stays, with its replacement; `member` filters values.
      r = await call('get_wpf_api_reference', { component: 'MapFillMode', member: 'chloropleth' });
      text = textOf(r);
      check('an obsolete enum value names its replacement',
        !r.isError && text.includes('_Showing 1 value whose name contains "chloropleth"._') && text.includes('This is a synonym for Choropleth. ⚠ OBSOLETE: Please use Choropleth instead.'),
        text.slice(-400));
      // Types that share a short name each have a page, opened by full name. The name alone opens the type of the family
      // Infragistics recommends, never a retired control's: "SelectionType" was XamGrid's (None, Single, Multiple), and an
      // agent on XamDataGrid wrote SelectionType.Multiple, which its SelectionType doesn't have.
      r = await call('get_wpf_api_reference', { component: 'SelectionType' });
      text = textOf(r);
      check('a shared name is not a retired control\'s type, and lists the others with the call that opens each',
        !r.isError && text.includes('**Full type name:** `Infragistics.Windows.Controls.SelectionType`') && text.includes('- **Extended** = 3:') &&
        text.includes('- `get_wpf_api_reference("Infragistics.Controls.Grids.SelectionType")` — 3 values (`None`, `Single`, `Multiple`), NuGet `Infragistics.WPF.Controls.Grids.XamGrid.Trial`'),
        text.slice(0, 1200));
      r = await call('get_wpf_api_reference', { component: 'Infragistics.Controls.Grids.SelectionType' });
      text = textOf(r);
      check('a full name opens a type that lost its short name',
        !r.isError && text.includes('**Full type name:** `Infragistics.Controls.Grids.SelectionType`') && text.includes('- **Multiple** = 2:') &&
        text.includes('`get_wpf_api_reference("Infragistics.Windows.Controls.SelectionType")` (what "SelectionType" alone returns)'),
        text.slice(0, 1200));
      r = await call('get_wpf_api_reference', { component: 'infragistics.windows.controls.selectiontype' });
      check('a full name opens the type that kept the name, case-insensitively',
        !r.isError && textOf(r).includes('**Full type name:** `Infragistics.Windows.Controls.SelectionType`') && textOf(r).includes('- **Extended** = 3:') &&
        !textOf(r).includes('(what "SelectionType" alone returns)'), textOf(r).slice(0, 400));
      r = await call('get_wpf_api_reference', { component: 'Infragistics.Windows.Editors.SelectionType' });
      check('an unknown full name of a known short name → isError listing the real ones',
        r.isError === true && textOf(r).includes('Type "Infragistics.Windows.Editors.SelectionType" not found') &&
        textOf(r).includes('- `get_wpf_api_reference("Infragistics.Controls.Grids.SelectionType")` — NuGet'), textOf(r).slice(0, 400));
      // Newer copies of legacy Infragistics.Windows types take their name: the ThemeManager of the newer themes (what
      // setup_wpf_theme applies, ApplicationTheme), the newer XamComboEditor (IsEditable, AllowFiltering, AutoComplete).
      r = await call('get_wpf_api_reference', { component: 'ThemeManager' });
      text = textOf(r);
      check('"ThemeManager" is the newer themes\' ThemeManager',
        !r.isError && text.includes('**Full type name:** `Infragistics.Themes.ThemeManager`') && text.includes('- **ApplicationTheme** `ThemeBase`:') &&
        text.includes('- `get_wpf_api_reference("Infragistics.Windows.Themes.ThemeManager")` — 17 members'),
        text.slice(0, 1200));
      r = await call('get_wpf_api_reference', { component: 'XamComboEditor', kind: 'properties', member: 'IsEditable' });
      text = textOf(r);
      check('"XamComboEditor" is the newer control, the legacy one listed by full name',
        !r.isError && text.includes('**Full type name:** `Infragistics.Controls.Editors.XamComboEditor`') && text.includes('xmlns:ig="http://schemas.infragistics.com/xaml"') &&
        text.includes('- **IsEditable** `Boolean`:') && text.includes('- `get_wpf_api_reference("Infragistics.Windows.Editors.XamComboEditor")` — 142 members, NuGet `Infragistics.WPF.Editors.Trial`'),
        text.slice(0, 1200));
      // A generic name is a valid code span: double-fenced, as its backtick would end a single-fenced one.
      r = await call('get_wpf_api_reference', { component: 'SelectedCollectionBase`1', kind: 'events' });
      check('a generic full name renders as one code span',
        !r.isError && textOf(r).includes('This page documents `` Infragistics.Controls.Menus.SelectedCollectionBase`1 `` (38 members), which'), textOf(r).slice(0, 1200));
      // A nested type's full name, as reflection writes it (Outer+Inner) or as C# does (Outer.Inner).
      r = await call('get_wpf_api_reference', { component: 'Infragistics.Olap.Xmla.XmlaDataSource+DataSourceState' });
      check('a nested type that lost its short name opens by Outer+Inner',
        !r.isError && textOf(r).includes('**Full type name:** `Infragistics.Olap.Xmla.XmlaDataSource.DataSourceState`') && textOf(r).includes(':XmlaDataSource+DataSourceState` (nested class)'),
        textOf(r).slice(0, 400));
      // Guard (passes on the code before full names too): a full name whose short name has no page is a plain not-found.
      r = await call('get_wpf_api_reference', { component: 'Infragistics.Controls.Grids.NoSuchTypeXyz' });
      check('an unknown full name → isError', r.isError === true && textOf(r).includes('not found'), textOf(r).slice(0, 200));
      // A type's page is built like any other: the legacy XamComboEditor inherits most of its API from ValueEditor.
      r = await call('get_wpf_api_reference', { component: 'Infragistics.Windows.Editors.XamComboEditor', kind: 'properties', member: 'Value' });
      text = textOf(r);
      check('a type that lost its short name has its inherited members',
        !r.isError && text.includes('xmlns:igEditors="http://infragistics.com/Editors"') && text.includes('### Properties (inherited from `ValueEditor`)') && text.includes('- **Value** `Object`:') &&
        text.includes('`get_wpf_api_reference("Infragistics.Controls.Editors.XamComboEditor")` (what "XamComboEditor" alone returns)'),
        text.slice(0, 600));
      // Two assemblies have an Infragistics.Controls.Editors.Caret: the assembly picks one.
      r = await call('get_wpf_api_reference', { component: 'Infragistics.Controls.Editors.Caret, Infragistics.WPF.Controls.Editors.XamRichTextEditor' });
      check('a full name two assemblies share opens the one its assembly names',
        !r.isError && textOf(r).includes('**Assembly:** `Infragistics.WPF.Controls.Editors.XamRichTextEditor`'), textOf(r).slice(0, 400));
      // XamSpreadsheet's package is the one with its DLL: Infragistics.WPF.Spreadsheet.Charts.Trial also ships its XML docs
      // (beside its own ChartAdapter DLL), and an agent installed that one from the scaffold.
      r = await call('get_wpf_api_reference', { component: 'XamSpreadsheet', kind: 'events' });
      check('XamSpreadsheet\'s NuGet package is the one with its DLL',
        !r.isError && textOf(r).includes('**NuGet:** `Infragistics.WPF.Spreadsheet.Trial`') && !textOf(r).includes('Spreadsheet.Charts') && !textOf(r).includes('is ambiguous'),
        textOf(r).slice(0, 600));
      // Search finds it by its members (agents searched these three looking for the newer XamComboEditor), and says how to open it.
      r = await call('search_wpf_api', { query: 'AutoComplete IsEditable AllowFiltering', limit: 5 });
      check('search finds the newer XamComboEditor, with its full name',
        !r.isError && textOf(r).includes('- **Several types are named "XamComboEditor":** open this one with get_wpf_api_reference("Infragistics.Controls.Editors.XamComboEditor")'),
        textOf(r).slice(0, 600));
      // A query that is a shared name lists its types first among equal scores: the Excel Axis used to rank 42nd.
      r = await call('search_wpf_api', { query: 'Axis' });
      check('search for a shared name lists the types of that name first among ties',
        !r.isError && textOf(r).includes('open this one with get_wpf_api_reference("Infragistics.Controls.Charts.Axis")') &&
        textOf(r).includes('open this one with get_wpf_api_reference("Infragistics.Documents.Excel.Charts.Axis")'),
        textOf(r).slice(0, 600));
      r = await call('list_wpf_components', { filter: 'XamComboEditor' });
      check('list_wpf_components lists the newer XamComboEditor and names the legacy one',
        !r.isError && textOf(r).includes('### XamComboEditor\n- **xmlns:** `xmlns:ig="http://schemas.infragistics.com/xaml"`\n- **NuGet:** `Infragistics.WPF.Controls.Editors.XamComboEditor.Trial`') &&
        textOf(r).includes('- ⚠️ Not the only XamComboEditor: `Infragistics.Windows.Editors.XamComboEditor` is another'), textOf(r).slice(0, 800));
      // The scaffold uses the same control, says there is another, and takes the other's full name.
      r = await call('get_wpf_project_scaffold', { components: ['XamComboEditor', 'XamSpreadsheet'], projectName: 'SmokeApp' });
      text = textOf(r);
      check('scaffold: the newer XamComboEditor, the other named; XamSpreadsheet\'s own package',
        !r.isError && text.includes('dotnet add package Infragistics.WPF.Controls.Editors.XamComboEditor.Trial\n') && text.includes('xmlns:ig="http://schemas.infragistics.com/xaml"') &&
        text.includes('not the only XamComboEditor: `Infragistics.Windows.Editors.XamComboEditor` is another') &&
        text.includes('dotnet add package Infragistics.WPF.Spreadsheet.Trial\n') && !text.includes('Spreadsheet.Charts'),
        text.slice(0, 1200));
      r = await call('get_wpf_project_scaffold', { components: ['Infragistics.Windows.Editors.XamComboEditor'], projectName: 'SmokeApp' });
      text = textOf(r);
      check('scaffold takes the full name of the other control of a name',
        !r.isError && text.includes('dotnet add package Infragistics.WPF.Editors.Trial\n') && text.includes('xmlns:igEditors="http://infragistics.com/Editors"') && !text.includes('not found'),
        text.slice(0, 1200));
    }
    r = await call('get_wpf_api_reference', { component: 'xamdatagrid', kind: 'events' });
    check('case-insensitive lookup + kind filter', !r.isError && textOf(r).includes('# XamDataGrid'));
    r = await call('get_wpf_api_reference', { component: 'NoSuchTypeXyz', kind: 'all' });
    check('unknown type → isError', r.isError === true);

    console.log('search_wpf_api');
    r = await call('search_wpf_api', { query: 'filter', limit: 5 });
    check('keyword search returns ranked results', !r.isError && textOf(r).startsWith(`${H1} WPF API Search`));
    if (IS_DOTNET) {
      // C# only: the TS server returns no results for limit <= 0 and doesn't enforce max lengths.
      r = await call('search_wpf_api', { query: 'filter', limit: 0 });
      check('limit 0 is clamped to 1 result', !r.isError && textOf(r).includes('(1 of '), textOf(r).slice(0, 300));
      r = await call('search_wpf_api', { query: 'filter '.repeat(100) });
      check('over-long query → isError naming the limit', r.isError === true && textOf(r).includes('max 128 characters'), textOf(r).slice(0, 300));
      r = await call('search_wpf_api', { query: '   ' });
      check('blank query → isError', r.isError === true && textOf(r).includes('must not be empty'), textOf(r).slice(0, 300));
    }
    // "active pane" used to rank the internal ActivePaneManager first.
    r = await call('search_wpf_api', { query: 'active pane', limit: 10 });
    check('search does not return internal classes', !r.isError && !textOf(r).includes('ActivePaneManager'), textOf(r).slice(0, 300));

    console.log('get_wpf_project_scaffold');
    r = await call('get_wpf_project_scaffold', { components: ['XamDataGrid', 'XamCategoryChart'], projectName: 'SmokeApp', framework: 'net10.0' });
    text = textOf(r);
    check('scaffold has dotnet commands and xmlns', !r.isError && text.includes('dotnet new') && text.includes('dotnet add') && text.includes('xmlns:'));
    check('package IDs keep their canonical casing', text.includes('dotnet add package Infragistics.WPF.DataGrids.Trial\n'), text.slice(0, 400));

    console.log('search_wpf_docs / get_wpf_doc');
    r = await call('search_wpf_docs', { control: 'XamDataGrid', limit: 5 });
    text = textOf(r);
    const slug = /\*\*Topic slug:\*\* `([^`]+)`/.exec(text)?.[1];
    check('browse by control returns topics with slugs', !r.isError && !!slug, text.slice(0, 300));
    if (slug) {
      r = await call('get_wpf_doc', { topic: slug });
      check(`get_wpf_doc("${slug}") returns body`, !r.isError && textOf(r).length > 200);
    }
    r = await call('search_wpf_docs', { query: 'column series', limit: 3 });
    check('docs-common topics resolved ({CategoryChartName} → real name)', !r.isError && /XamCategoryChart|XamDataChart/.test(textOf(r)), textOf(r).slice(0, 300));
    // The Windows Forms / ASP.NET UltraChart docs (docs-common's win-web-chart, {WawChartName}) are not WPF.
    r = await call('search_wpf_docs', { query: 'bar chart specific properties export pdf', limit: 50 });
    check('no Windows Forms / ASP.NET chart topics', !textOf(r).includes('{WawChartName}'), textOf(r).slice(0, 300));
    if (IS_DOTNET) {
      // C# only: the TS server strips hyphens but not spaces from control names.
      r = await call('search_wpf_docs', { control: 'ThemeManager', limit: 50 });
      text = textOf(r);
      check('control "ThemeManager" matches topics tagged "IG Theme Manager"', !r.isError && text.includes('IG Theme Manager'), text.slice(0, 300));
      // Topics tagged with a family (xamInputs, xamDataPresenter) are found by the controls they name.
      r = await call('search_wpf_docs', { control: 'XamMaskedInput', limit: 3 });
      check('control filter finds a family-tagged control', !r.isError && textOf(r).includes('**Controls:** xamInputs'), textOf(r).slice(0, 300));
      r = await call('search_wpf_docs', { control: 'XamDataGrid', query: 'field layout', limit: 10 });
      check('XamDataGrid also finds its xamDataPresenter topics', !r.isError && textOf(r).includes('**Controls:** xamDataPresenter'), textOf(r).slice(0, 300));
      // Topics without a metadata name are kept by their title, which the sources' byte-order mark used to hide: all
      // of shape-chart and most of financial-chart were missing. Those that name no control get their folder's.
      r = await call('search_wpf_docs', { control: 'XamFinancialChart', limit: 10 });
      check('XamFinancialChart finds its getting-started topic', !r.isError && textOf(r).includes('`financial-chart-gettingstarted`'), textOf(r).slice(0, 300));
      // A folder alias ("financial-chart") stands for the folder's control: 10 of those 13 topics ranked 23rd to 32nd,
      // below the ones that name no control (the other 3: 4th, 5th, 10th). An unresolved {Placeholder} (a typo in the
      // source) names no control.
      r = await call('search_wpf_docs', { control: 'XamFinancialChart', limit: 15 });
      text = textOf(r);
      check('topics naming the folder alias rank with their siblings',
        !r.isError && text.includes('`financial-chart-chart-tooltips`') && !text.includes('**Controls:** financial-chart'), text.slice(0, 300));
      r = await call('search_wpf_docs', { control: 'XamDataPieChart', limit: 10 });
      check('a topic naming an unresolved placeholder gets its folder\'s control',
        !r.isError && /`data-pie-chart-data-binding`\n- \*\*Matched on:\*\*[^\n]*\n- \*\*Controls:\*\* XamDataPieChart\n/.test(textOf(r)), textOf(r).slice(0, 300));
      r = await call('search_wpf_docs', { control: 'XamShapeChart', limit: 15 });
      const shapeSlugs = [...textOf(r).matchAll(/\*\*Topic slug:\*\* `([^`]+)`/g)].map(m => m[1]);
      check('XamShapeChart topics rank above release notes that mention it', shapeSlugs.length === 15 && shapeSlugs.every(s => s.startsWith('shapechart-')), shapeSlugs.join(', '));
      // docs-common's scheduler folder is the Xamarin XamScheduler, not part of the WPF docs; as XamScheduler topics they matched
      // "xamSchedule" by substring (8 of the top 10 for this query). WPF's XamSchedule family is in docs-wpf.
      r = await call('search_wpf_docs', { query: 'xamSchedule appointments', limit: 10 });
      text = textOf(r);
      check('"xamSchedule" finds the XamSchedule topics, not the Xamarin scheduler ones',
        !r.isError && text.includes('`xamschedule-using-activities-appointments`') && !text.includes('**Topic slug:** `scheduler'), text.slice(0, 300));
      r = await call('search_wpf_docs', { control: 'xamSchedule', limit: 50 });
      check('control "xamSchedule" lists no Xamarin scheduler topics',
        !r.isError && textOf(r).includes('`xamschedule-getting-started`') && !textOf(r).includes('**Topic slug:** `scheduler'), textOf(r).slice(0, 300));
      // No WPF topic says "scheduler" (XamScheduler is the Xamarin control): the empty result points to the XamSchedule family.
      r = await call('search_wpf_docs', { query: 'scheduler' });
      check('"scheduler" points to control "xamSchedule"', r.isError === true && textOf(r).includes('search_wpf_docs(control: "xamSchedule")'), textOf(r).slice(0, 300));
      r = await call('search_wpf_docs', { query: 'TaskScheduler' });
      check('"TaskScheduler" gets no XamScheduler hint', !textOf(r).includes('XamScheduler'), textOf(r).slice(0, 300));
      // docs-common's productivity-tools folder also has Xamarin.Forms topics, which only its ifdef::xamarin[] blocks link.
      r = await call('get_wpf_doc', { topic: 'using-control-configurator-with-xamarin-data-grid' });
      check('the Xamarin.Forms data grid configurator topic is left out', r.isError === true, textOf(r).slice(0, 200));
      // include:: pastes the included file: this topic was its title, Purpose and Required Background (504 characters).
      r = await call('get_wpf_doc', { topic: 'xamdatagrid-crossfieldrecordfiltering' });
      text = textOf(r);
      check('include:: content is pasted in', !r.isError && text.includes('## Specifying Filters Programmatically') && text.includes('RecordFilterScope'), text.slice(-200));
      // A file that is its own title and an include:: of a whole topic is that topic under its own title, not under both.
      r = await call('get_wpf_doc', { topic: 'xamdatapresenter-field-grouping' });
      check('a whole topic pasted under a title of its own keeps one title',
        !r.isError && textOf(r).startsWith('## Field Grouping (xamDataPresenter)\n') && !textOf(r).includes('# Field Grouping (xamDataGrid)'), textOf(r).slice(0, 300));
      // A topic published for two controls (xamdatagrid-X and xamdatapresenter-X paste one include:: file) is listed once,
      // as the copy for `control`, naming the other: both copies took places and pushed xamdatagrid-exporting-data out.
      r = await call('search_wpf_docs', { query: 'export DataPresenter control to Excel', control: 'xamDataGrid', limit: 6 });
      text = textOf(r);
      check('the same text is listed once, as the copy for `control`',
        !r.isError && text.includes('**Topic slug:** `xamdatagrid-configuring-custom-tab-navigation`') &&
        text.includes('**Same text also under:** `xamdatapresenter-configuring-custom-tab-navigation`') &&
        !text.includes('**Topic slug:** `xamdatapresenter-configuring-custom-tab-navigation`') && text.includes('`xamdatagrid-exporting-data`'),
        text.slice(0, 300));
      r = await call('search_wpf_docs', { query: 'record filtering filter record', control: 'xamDataPresenter', limit: 8 });
      text = textOf(r);
      check('with control "xamDataPresenter", its own copy is the one listed',
        !r.isError && text.includes('**Topic slug:** `xamdatapresenter-crossfieldrecordfiltering`') && !text.includes('**Topic slug:** `xamdatagrid-crossfieldrecordfiltering`'),
        text.slice(0, 300));
      // The included file itself still opens by its metadata name, but isn't listed as a third copy.
      r = await call('search_wpf_docs', { control: 'XamCurrencyEditor', limit: 15 });
      check('an include:: fragment is not listed', !r.isError && !textOf(r).includes('**Topic slug:** `configuring-specific-editor-fields`'), textOf(r).slice(0, 300));
      r = await call('get_wpf_doc', { topic: 'configuring-specific-editor-fields' });
      check('the include:: fragment still opens by its slug', !r.isError && textOf(r).includes('CurrencyField'), textOf(r).slice(0, 200));
      // A metadata name several files claim belongs to the file named after it; the rest keep their own file names.
      r = await call('get_wpf_doc', { topic: 'piechart-selection' });
      check('"piechart-selection" is the pie chart selection topic', !r.isError && textOf(r).startsWith('## Selection\n') && textOf(r).includes('selection feature in the XamPieChart'), textOf(r).slice(0, 300));
      r = await call('get_wpf_doc', { topic: 'data-pie-chart' });
      check('the data pie chart overview, also named "piechart-selection", has its own slug', !r.isError && textOf(r).startsWith('## XamDataPieChart\n'), textOf(r).slice(0, 300));
      r = await call('get_wpf_doc', { topic: 'whats-new-in-2017-volume-1' });
      check('"whats-new-in-2017-volume-1" is volume 1, not volume 2 that also claims the name', !r.isError && textOf(r).startsWith('## What\'s New in 2017 Volume 1\n'), textOf(r).slice(0, 300));
      // home-page.adoc is wpf-netadvantage-win-client-wpf.adoc byte for byte, metadata name included: not another topic.
      r = await call('get_wpf_doc', { topic: 'home-page' });
      check('a copy of the file that keeps a name is left out', r.isError === true, textOf(r).slice(0, 200));
      // The data pie chart files that claim piechart-selection copied its {PieChartName} too: they get their folder's control.
      r = await call('get_wpf_doc', { topic: 'data-pie-chart-animation' });
      check('a docs-common topic that took its file name is tagged with its folder\'s control', !r.isError && textOf(r).includes('**Controls:** XamDataPieChart\n'), textOf(r).slice(0, 300));
      // docs-wpf's bulletgraph.adoc is only its title; the docs site serves docs-common's overview of the same name.
      r = await call('get_wpf_doc', { topic: 'bulletgraph' });
      check('a docs-common topic replaces the docs-wpf stub of the same name', !r.isError && textOf(r).includes('In This Group of Topics'), textOf(r).slice(0, 300));
      // ifdef::XAML[] is WPF content too (build flags are matched case-insensitively).
      r = await call('get_wpf_doc', { topic: 'shapechart-series-requirements' });
      check('recovered topic opens, its ifdef::XAML[] note kept', !r.isError && textOf(r).includes('Points column must be a list of lists'), textOf(r).slice(0, 300));
      // A topic with no `= Title` takes its one top-level `== ` heading.
      r = await call('get_wpf_doc', { topic: 'nuget-packages' });
      check('topic titled with == keeps its title', !r.isError && textOf(r).startsWith('## Infragistics NuGet Packages\n'), textOf(r).slice(0, 200));
      // Whole topics up to ~24K characters (this one, 22K, used to be cut at 6,000), with their code fenced.
      r = await call('get_wpf_doc', { topic: 'implementing-undo-redo-crud-operations-in-xamgrid-control' });
      text = textOf(r);
      check('long topic comes back whole', !r.isError && !text.includes('truncated') && text.trimEnd().endsWith('Undo/Redo Framework™.') && text.includes('```csharp'), text.slice(-200));
      // Code keeps its {…} tokens: the body used to read XAxisLabel="{}".
      r = await call('get_wpf_doc', { topic: 'categorychart-binding-to-data' });
      check('code keeps {Name}-style tokens', !r.isError && textOf(r).includes('XAxisLabel="{}{Name}"'), textOf(r).slice(0, 200));
      // Longer topics come in pages, each with balanced code fences.
      r = await call('get_wpf_doc', { topic: 'resources-customtheme.xamtilemanager', page: 2 });
      text = textOf(r);
      check('long topic pages with balanced fences', !r.isError && /comes in \d+ pages/.test(text) && text.includes('this is page 2') && (text.match(/^```/gm)?.length ?? 1) % 2 === 0, text.slice(0, 300));
      r = await call('get_wpf_doc', { topic: 'resources-customtheme.xamtilemanager', page: 99 });
      check('page out of range → isError', r.isError === true && textOf(r).includes('out of range'), textOf(r).slice(0, 200));
      // [Range(1, 100)] isn't enforced by the SDK: page 0 is out of range too, for long and one-page topics alike.
      r = await call('get_wpf_doc', { topic: 'resources-customtheme.xamtilemanager', page: 0 });
      check('page 0 → out-of-range isError', r.isError === true && textOf(r).includes('page 0 is out of range'), textOf(r).slice(0, 200));
      r = await call('get_wpf_doc', { topic: 'adding-an-assembly-to-an-expression-blend-project', page: 0 });
      check('page 0 of a one-page topic → out-of-range isError', r.isError === true && textOf(r).includes('page 0 is out of range'), textOf(r).slice(0, 200));
    }
    r = await call('get_wpf_doc', { topic: 'no-such-topic-slug' });
    check('unknown slug → isError', r.isError === true);

    console.log('setup_wpf_theme');
    r = await call('setup_wpf_theme', {});
    text = textOf(r);
    check('lists both theme families', !r.isError && text.includes('MetroDark') && text.includes('ThemeManager') && text.includes('DefaultStyles'), text.slice(0, 300));
    r = await call('setup_wpf_theme', { component: 'DataChart', theme: 'MetroDark' });
    text = textOf(r);
    const path = /`(Themes\/[^`]+\.xaml)`/.exec(text)?.[1];
    check('component+theme filter yields a resource path', !r.isError && !!path, text.slice(0, 300));
    if (IS_DOTNET) {
      // The IG theme's class is IgTheme; `new IGTheme()` does not compile (C# server only — src/ is not updated).
      r = await call('setup_wpf_theme', { component: 'DataChart', theme: 'IG' });
      text = textOf(r);
      check('IG apply block uses the IgTheme class', !r.isError && text.includes('new Infragistics.Themes.IgTheme()') && !text.includes('IGTheme()'), text.slice(0, 600));
    }

    console.log('get_wpf_theme_resource');
    if (path) {
      // C# returns an overview for files over 24K (this one is ~155K) and the XAML by page; the frozen TS server cuts it off.
      r = await call('get_wpf_theme_resource', IS_DOTNET ? { path, page: 1 } : { path });
      check(`returns XAML for ${path}`, !r.isError && textOf(r).includes('<ResourceDictionary'));
    }
    if (IS_DOTNET && path) {
      // Large theme files are no longer cut off: overview, then pages that concatenate to the exact file.
      r = await call('get_wpf_theme_resource', { path });
      text = textOf(r);
      const pageCount = Number(/comes in (\d+) pages/.exec(text)?.[1] ?? 0);
      check('large theme file returns a contents overview', !r.isError && pageCount > 1 && text.includes('## Contents') && text.length <= 25_000, text.slice(0, 300));
      let joined = '';
      for (let p = 1; p <= pageCount; p++) {
        const pr = await call('get_wpf_theme_resource', { path, page: p });
        joined += /```xml\n([\s\S]*)\n```$/.exec(textOf(pr))?.[1] ?? '\u0000';
      }
      const onDisk = readFileSync(join(dirname(TARGET.entry), 'data', 'theme-resources', path), 'utf8').replace(/^\uFEFF/, '');
      check(`its ${pageCount} pages concatenate to the exact file`, joined === onDisk, `${joined.length} vs ${onDisk.length} chars`);
      // 36 matches here, so the result itself takes 2 pages: the root start tag is on the first, the end tag on the last.
      r = await call('get_wpf_theme_resource', { path, find: 'Legend' });
      text = textOf(r);
      const findPages = Number(/\(page 1 of (\d+)\)/.exec(text)?.[1] ?? 1);
      let found = /```xml\n([\s\S]*)\n```$/.exec(text)?.[1] ?? '';
      for (let p = 2; p <= findPages; p++)
        found += /```xml\n([\s\S]*)\n```$/.exec(textOf(await call('get_wpf_theme_resource', { path, find: 'Legend', page: p })))?.[1] ?? '';
      check('find returns matching entries in full, inside the root element',
        !r.isError && /entr(y|ies) matching "Legend"/.test(text) && found.includes('<ResourceDictionary') && found.trimEnd().endsWith('</ResourceDictionary>'),
        text.slice(0, 300));
      r = await call('get_wpf_theme_resource', { path, page: pageCount + 1 });
      check('a page past the end is a clear error', r.isError === true && textOf(r).includes('out of range'));
    }
    r = await call('get_wpf_theme_resource', { path: '../../package.json' });
    check('path traversal is rejected', r.isError === true);

    console.log('get_wpf_theme_palette');
    r = await call('get_wpf_theme_palette', { theme: 'MetroDark' });
    text = textOf(r);
    check('MetroDark palette has color keys', !r.isError && /Color_\d+|Brush\d+/.test(text), text.slice(0, 300));
    r = await call('get_wpf_theme_palette', {});
    check('omitting theme returns the chooser', !r.isError && textOf(r).includes('MetroDark'));
    if (IS_DOTNET) {
      // Overriding palette keys does not recolor a theme (verified); the tool returns verified recolor steps
      // instead, with class names read from each theme's own files (C# server only — src/ is not updated).
      r = await call('get_wpf_theme_palette', { theme: 'RoyalDark' });
      text = textOf(r);
      check('no palette-override skeleton', !r.isError && !text.includes('Override skeleton') && text.includes('does not recolor the theme'), text.slice(-600));
      check('RoyalDark steps name its compiled grid and DockManager classes',
        text.includes('igThemes:DataPresenterRoyalDark.CellValuePresenter') && text.includes('DockManagerRoyalDark_Brushes.xaml') && text.includes('Infragistics.Themes.RoyalDarkTheme'));
      r = await call('get_wpf_theme_palette', { theme: 'IG' });
      text = textOf(r);
      check('IG steps use IgTheme and DataPresenterIGTheme',
        !r.isError && text.includes('Infragistics.Themes.IgTheme') && text.includes('igThemes:DataPresenterIGTheme.CellValuePresenter') && !text.includes('IGTheme()'));
    }

    if (IS_DOTNET) {
      console.log('stderr');
      check('no SDK info lines without --debug', !/^info:/m.test(stderr.join('')), stderr.join('').slice(0, 300));
    }
  } finally {
    await client.close();
  }

  if (IS_DOTNET) {
    // C# only: a second server with --debug; parallel calls must each get a log entry. stderr is
    // ignored, not piped: --debug turns on the SDK's info lines and an unread pipe would fill up.
    console.log('--debug log');
    const logPath = join(tmpdir(), `wpf-mcp-smoke-${process.pid}.log`);
    rmSync(logPath, { force: true });
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const debugClient = new Client({ name: 'wpf-mcp-smoke-test', version: '0.0.0' });
    await debugClient.connect(new StdioClientTransport({
      command: TARGET.command, args: [...TARGET.args, '--debug'], env: { ...env, WPF_MCP_LOG: logPath }, stderr: 'ignore',
    }));
    try {
      const calls = 20;
      await Promise.all(Array.from({ length: calls }, (_, i) =>
        debugClient.callTool({ name: 'search_wpf_api', arguments: { query: `filter ${i}`, limit: 1 } })));
      const entries = existsSync(logPath) ? readFileSync(logPath, 'utf8').match(/^\[[^\]]+\] search_wpf_api \(\d+ms\)$/gm)?.length ?? 0 : 0;
      check(`${calls} parallel calls → ${calls} log entries`, entries === calls, `${entries} entries in ${logPath}`);
    } finally {
      await debugClient.close();
      rmSync(logPath, { force: true });
    }
  }

  const ms = Math.round(performance.now() - start);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed (${ms}ms)`);
    if (stderr.length) console.error(`\nserver stderr:\n${stderr.join('')}`);
    process.exit(1);
  }
  console.log(`\nAll checks passed (${ms}ms).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
