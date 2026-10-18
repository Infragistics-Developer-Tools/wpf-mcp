using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Infragistics.Wpf.Mcp.Data;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Infragistics.Wpf.Mcp.Tools;

[McpServerToolType]
public sealed partial class ThemeTools(DataStore store, ToolLog log)
{
    // ── setup_wpf_theme ──────────────────────────────────────────────────────

    private const string NewerMechanismLine =
        "_Newer family (`Themes/`): apply via `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` in App.xaml.cs (the IG theme's class is `IgTheme`; requires the `Infragistics.WPF.Themes.<Name>.Trial` NuGet package). Do NOT merge these files directly into `Application.Resources`._";

    private const string LegacyMechanismLine =
        "_Legacy family (`DefaultStyles/`): the named theme is already embedded in the component's assembly — just set `Theme=\"<Name>\"` on the control. Use these files only to copy/override individual Styles/ControlTemplates._";

    private static readonly string ThemeMechanismGuide = string.Join('\n', new[]
    {
        "## How to apply a theme",
        "",
        LegacyMechanismLine,
        "",
        NewerMechanismLine,
        "",
        "**Newer-family apply template (replace `<Name>` with the theme):**",
        "```sh",
        "dotnet add package Infragistics.WPF.Themes.<Name>.Trial",
        "```",
        "```csharp",
        "// App.xaml.cs — set before the first window is created (the IG theme's class is IgTheme)",
        "Infragistics.Themes.ThemeManager.ApplicationTheme = new Infragistics.Themes.<Name>Theme();",
        "```",
    });

    // ThemeManager theme classes are "<folder>Theme" (MetroDarkTheme, RoyalDarkTheme, …) except IG,
    // whose class is IgTheme: `new IGTheme()` fails with CS0234 (verified by compiling, 26.1.54).
    private static string ThemeClassName(string theme) =>
        string.Equals(theme, "IG", StringComparison.OrdinalIgnoreCase) ? "IgTheme" : $"{theme}Theme";

    private static string NewerApplyBlock(string theme) => string.Join('\n', new[]
    {
        "",
        $"**Apply `{theme}` (ready to paste):**",
        "```sh",
        $"dotnet add package Infragistics.WPF.Themes.{theme}.Trial",
        "```",
        "```csharp",
        "// App.xaml.cs — set before the first window is created",
        "protected override void OnStartup(StartupEventArgs e)",
        "{",
        $"    Infragistics.Themes.ThemeManager.ApplicationTheme = new Infragistics.Themes.{ThemeClassName(theme)}();",
        "    base.OnStartup(e);",
        "}",
        "```",
        "_Covers the newer \"Infragistics.Controls.*\" family (charts, gauges, maps, XamGrid, etc.)._",
    });

    // Built-in WPF types that appear as TargetType in nearly every ControlTemplate — an exact
    // match on one of these says nothing about which control a file is for, so a component
    // filter equal to one of them falls back to filename matching only.
    private static readonly HashSet<string> GenericWpfTargetTypes = new(StringComparer.Ordinal)
    {
        "grid", "border", "button", "textblock", "textbox", "path", "rectangle", "ellipse",
        "canvas", "stackpanel", "contentcontrol", "itemscontrol", "listbox", "listboxitem",
        "scrollviewer", "togglebutton", "repeatbutton", "thumb", "popup", "image", "label",
        "checkbox", "radiobutton", "combobox", "comboboxitem", "expander", "gridsplitter",
        "menuitem", "progressbar", "slider", "tabitem", "tabcontrol", "treeviewitem", "treeview",
    };

    private static IEnumerable<string> FormatResourceFiles(ThemeResourceFile[] files, int limit, string? componentFilter)
    {
        var shown = files.Take(limit).ToArray();
        var lines = shown.Select(f =>
        {
            var line = $"  - `{f.Path}`";
            // Say so when the file matched only via a TargetType inside it, not its own name.
            if (componentFilter is not null && !f.File.ToLowerInvariant().Contains(componentFilter, StringComparison.Ordinal))
            {
                var matchedType = f.TargetTypes.FirstOrDefault(t => t.ToLowerInvariant() == componentFilter);
                if (matchedType is not null)
                    line += $" — styles `{matchedType}` directly (bundled with other control types under this file name)";
            }
            return line;
        }).ToList();
        var remaining = files.Length - shown.Length;
        if (remaining > 0)
            lines.Add($"  - _...and {remaining} more file(s) — narrow further with `component` and/or `theme` to see them_");
        return lines;
    }

    [McpServerTool(Name = "setup_wpf_theme", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.SetupWpfTheme)]
    public CallToolResult SetupTheme(
        [Description("""
            Optional component/keyword filter, e.g. "XamDataGrid", "Ribbon", "DataChart", "DockManager".
                  Case-insensitive substring match against legacy style folder names AND per-control theme file names
                  (both families) — so you can filter by a control folder ("Ribbon") or by a specific file name ("RibbonMetroDark").
                  Omit to list every available theme name and legacy style folder with a file count.
            """)]
        [MaxLength(64)]
        string? component = null,
        [Description("""
            Optional theme name filter, e.g. "MetroDark", "RoyalDark", "Office2013", "Metro".
                  Case-insensitive substring match. Combine with `component` to find one exact file.
            """)]
        [MaxLength(64)]
        string? theme = null)
    {
        var timer = Stopwatch.StartNew();
        var input = new { component, theme };
        var index = store.ThemeIndex;
        var componentFilter = component?.ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(componentFilter)) componentFilter = null;
        var themeFilter = theme?.ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(themeFilter)) themeFilter = null;

        var output = new List<string>();

        if (componentFilter is null && themeFilter is null)
        {
            output.Add("# Available WPF Themes");
            output.Add("");
            output.Add("## Newer family (ThemeManager) — theme names");
            output.AddRange(index.NewerThemes.Select(t => $"- **{t.Theme}** ({t.Files.Length} file{(t.Files.Length == 1 ? "" : "s")})"));
            output.Add("");
            output.Add("## Legacy family (Theme=\"...\" property) — style folders");
            output.AddRange(index.LegacyStyles.Select(s => $"- **{s.Folder}** ({s.Files.Length} file{(s.Files.Length == 1 ? "" : "s")})"));
            output.Add("");
            output.Add(ThemeMechanismGuide);
            output.Add("");
            output.Add("_Pass `component` and/or `theme` to filter down to exact file paths, then call get_wpf_theme_resource(path) to read one._");
            var browse = string.Join('\n', output);
            log.Write("setup_wpf_theme", input, browse, timer);
            return ToolResult.Text(browse);
        }

        var matchedNewer = index.NewerThemes
            .Where(t => themeFilter is null || t.Theme.ToLowerInvariant().Contains(themeFilter, StringComparison.Ordinal))
            .Select(t => (theme: t.Theme, files: t.Files.Where(f =>
                componentFilter is null ||
                f.File.ToLowerInvariant().Contains(componentFilter, StringComparison.Ordinal) ||
                (!GenericWpfTargetTypes.Contains(componentFilter) && f.TargetTypes.Any(tt => tt.ToLowerInvariant() == componentFilter))
            ).ToArray()))
            .Where(t => t.files.Length > 0)
            .ToArray();

        var matchedLegacy = index.LegacyStyles
            .Select(s =>
            {
                // `component` matches the folder, a file name, or a real TargetType inside the
                // file; `theme` matches file names.
                var folderMatchesComponent = componentFilter is null || s.Folder.ToLowerInvariant().Contains(componentFilter, StringComparison.Ordinal);
                var files = s.Files.Where(f =>
                {
                    var nameLower = f.File.ToLowerInvariant();
                    var componentOk =
                        folderMatchesComponent ||
                        nameLower.Contains(componentFilter ?? "", StringComparison.Ordinal) ||
                        (componentFilter is not null && !GenericWpfTargetTypes.Contains(componentFilter) && f.TargetTypes.Any(tt => tt.ToLowerInvariant() == componentFilter));
                    var themeOk = themeFilter is null || nameLower.Contains(themeFilter, StringComparison.Ordinal);
                    return componentOk && themeOk;
                }).ToArray();
                return (folder: s.Folder, files);
            })
            .Where(s => s.files.Length > 0)
            .ToArray();

        if (matchedNewer.Length == 0 && matchedLegacy.Length == 0)
        {
            var msg = $"No theme resource files matched component=\"{component ?? ""}\" theme=\"{theme ?? ""}\". Call setup_wpf_theme with no arguments to browse all available theme names and style folders.";
            log.Write("setup_wpf_theme", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var totalFiles = matchedNewer.Sum(t => t.files.Length) + matchedLegacy.Sum(s => s.files.Length);

        output.Add($"# WPF Theme Resources{(!string.IsNullOrEmpty(component) ? $" — component: \"{component}\"" : "")}{(!string.IsNullOrEmpty(theme) ? $" — theme: \"{theme}\"" : "")} ({totalFiles} file{(totalFiles == 1 ? "" : "s")})");

        if (matchedNewer.Length > 0)
        {
            output.Add("");
            output.Add("## Newer family (ThemeManager)");
            foreach (var t in matchedNewer)
            {
                output.Add("");
                output.Add($"### {t.theme}");
                output.AddRange(FormatResourceFiles(t.files, 20, componentFilter));
                output.Add(NewerApplyBlock(t.theme));
            }
        }

        if (matchedLegacy.Length > 0)
        {
            output.Add("");
            output.Add("## Legacy family (Theme=\"...\" property)");
            foreach (var s in matchedLegacy)
            {
                output.Add("");
                output.Add($"### {s.folder}");
                output.AddRange(FormatResourceFiles(s.files, 20, componentFilter));
            }
        }

        output.Add("");
        if (matchedLegacy.Length > 0) output.Add(LegacyMechanismLine);
        if (matchedNewer.Length > 0) output.Add(NewerMechanismLine);

        if (totalFiles == 1)
        {
            var singlePath = matchedNewer.Length > 0 ? matchedNewer[0].files[0].Path : matchedLegacy[0].files[0].Path;
            output.Add("");
            output.Add($"_Exactly one file matched — call `get_wpf_theme_resource(\"{singlePath}\")` to read its XAML content._");
        }
        else
        {
            output.Add("");
            output.Add("_Call `get_wpf_theme_resource(path)` with any path above to read the full XAML content._");
        }

        var text = string.Join('\n', output);
        log.Write("setup_wpf_theme", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_theme_resource ───────────────────────────────────────────────

    // Style files average ~60KB and can reach ~660KB; 24000 chars (~5-6k tokens) fits a
    // full ControlTemplate while capping the largest blobs.
    private const int MaxThemeFileChars = 24000;

    [McpServerTool(Name = "get_wpf_theme_resource", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfThemeResource)]
    public CallToolResult GetThemeResource(
        [Description("""
            The exact resource path returned by setup_wpf_theme, e.g.
                  "Themes/MetroDark/MetroDark.xamDataChart.xaml" or "DefaultStyles/Ribbon/RibbonMetroDark.xaml".
                  Call setup_wpf_theme first — never guess this path.
            """)]
        [MinLength(1), MaxLength(200)]
        string path)
    {
        var timer = Stopwatch.StartNew();
        var input = new { path };

        var content = store.LoadThemeResource(path);
        if (content is null)
        {
            var needle = path.Split('\\', '/').Last().ToLowerInvariant();
            var allFiles = store.ThemeIndex.NewerThemes.SelectMany(t => t.Files)
                .Concat(store.ThemeIndex.LegacyStyles.SelectMany(s => s.Files));
            var suggestions = allFiles
                .Where(f => f.File.ToLowerInvariant().Contains(needle, StringComparison.Ordinal))
                .Take(5)
                .Select(f => $"`{f.Path}`")
                .ToArray();
            var hint = suggestions.Length > 0
                ? $" Did you mean: {string.Join(", ", suggestions)}?"
                : " Call setup_wpf_theme to browse available paths — never guess this path.";
            var msg = $"Theme resource \"{path}\" not found.{hint}";
            log.Write("get_wpf_theme_resource", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var isNewerFamily = path.Replace('\\', '/').StartsWith("Themes/", StringComparison.Ordinal);
        var mechanismNote = isNewerFamily
            ? "_Newer family: apply via `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` (the IG theme's class is `IgTheme`) — do not merge this file directly into Application.Resources._"
            : "_Legacy family: the named theme is already embedded in the component assembly — set `Theme=\"...\"` on the control. Use this file to copy/override specific styles only._";

        var shown = content.Length > MaxThemeFileChars
            ? $"{content[..MaxThemeFileChars]}\n<!-- truncated, {content.Length} chars total -->"
            : content;

        var text = string.Join('\n', new[]
        {
            $"# {path}",
            "",
            mechanismNote,
            "",
            "```xml",
            shown,
            "```",
        });

        log.Write("get_wpf_theme_resource", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_theme_palette ────────────────────────────────────────────────

    private sealed record PaletteEntry(string Group, string Kind, string Key, string Value, string? Note);

    [GeneratedRegex(@"^<!--\s*(.*?)\s*-->$")]
    private static partial Regex HeaderComment();

    [GeneratedRegex(@"<SolidColorBrush\s+x:Key=""([^""]+)""\s+Color=""([^""]+)""\s*/>\s*(?:<!--\s*(.*?)\s*-->)?")]
    private static partial Regex BrushLine();

    [GeneratedRegex(@"<Color\s+x:Key=""([^""]+)""\s*>\s*([^<]+?)\s*</Color>\s*(?:<!--\s*(.*?)\s*-->)?")]
    private static partial Regex ColorLine();

    [GeneratedRegex(@"^[-\s]+|[-\s]+$")]
    private static partial Regex LabelTrim();

    [GeneratedRegex(@"\r?\n")]
    private static partial Regex LineBreak();

    /// Strip decorative `*`/`-` runs from a XAML comment used as a section header.
    private static string CleanGroupLabel(string raw) =>
        LabelTrim().Replace(raw.Replace("*", ""), "").Trim();

    private static string? Note(Match m)
    {
        if (!m.Groups[3].Success) return null;
        var note = m.Groups[3].Value.Trim();
        return note.Length > 0 ? note : null;
    }

    /// Parses a `<Theme>.Theme.Colors.xaml` palette into grouped Color/Brush entries; groups
    /// come from the file's own standalone `<!-- ... -->` section comments, never guessed.
    private static List<PaletteEntry> ParsePalette(string xaml)
    {
        var entries = new List<PaletteEntry>();
        var group = "General";

        foreach (var line in LineBreak().Split(xaml))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;

            var header = HeaderComment().Match(trimmed);
            if (header.Success)
            {
                var label = CleanGroupLabel(header.Groups[1].Value);
                if (label.Length > 0) group = label;
                continue;
            }

            var brush = BrushLine().Match(trimmed);
            if (brush.Success)
            {
                entries.Add(new PaletteEntry(group, "Brush", brush.Groups[1].Value, brush.Groups[2].Value, Note(brush)));
                continue;
            }

            var color = ColorLine().Match(trimmed);
            if (color.Success)
            {
                entries.Add(new PaletteEntry(group, "Color", color.Groups[1].Value, color.Groups[2].Value, Note(color)));
            }
        }

        return entries;
    }

    private const string PaletteFileSuffix = ".theme.colors.xaml";

    private (string theme, ThemeResourceFile file)[] ThemesWithPalette() =>
        store.ThemeIndex.NewerThemes
            .Select(t => (theme: t.Theme, file: t.Files.FirstOrDefault(f => f.File.ToLowerInvariant().EndsWith(PaletteFileSuffix, StringComparison.Ordinal))))
            .Where(t => t.file is not null)
            .Select(t => (t.theme, t.file!))
            .ToArray();

    // ── recolor guidance ─────────────────────────────────────────────────────
    // Verified in test apps (Infragistics 26.1.54; RoyalDark and IG; chart, grid, gauge, DockManager,
    // standard WPF controls): overriding palette keys never recolors a ThemeManager theme — each theme
    // file merges its own copy of <Theme>.Theme.Colors.xaml and resolves it with StaticResource, and
    // ThemeManager appends its dictionary after the app's. Control-level overrides and an extended
    // theme (ThemeBase subclass remapping files) do work.

    [GeneratedRegex(@"<igThemes:([A-Za-z0-9]+)\s*/>")]
    private static partial Regex CompiledThemeClassTag();

    /// The compiled theme class a ThemeManager wrapper file merges, read from the file itself so the
    /// per-theme names stay exact: `DataPresenterRoyalDark`, but `DataPresenterIGTheme` for IG.
    private string? CompiledThemeClass(ThemeResourceFile[] files, string fileSuffix, string classPrefix)
    {
        var file = files.FirstOrDefault(f => f.File.EndsWith(fileSuffix, StringComparison.OrdinalIgnoreCase));
        var xaml = file is null ? null : store.LoadThemeResource(file.Path);
        return xaml is null ? null : CompiledThemeClassTag().Matches(xaml)
            .Select(m => m.Groups[1].Value)
            .FirstOrDefault(n => n.StartsWith(classPrefix, StringComparison.Ordinal) && !n.EndsWith("Brushes", StringComparison.Ordinal));
    }

    /// `<theme><suffix>` as the file is actually named in the theme folder.
    private static string ThemeFile(ThemeResourceFile[] files, string theme, string suffix) =>
        files.FirstOrDefault(f => f.File.Equals(theme + suffix, StringComparison.OrdinalIgnoreCase))?.File ?? theme + suffix;

    private string RecolorGuidance(string theme, ThemeResourceFile[] files)
    {
        var themeClass = ThemeClassName(theme);
        var dpClass = CompiledThemeClass(files, ".xamDataPresenter.xaml", "DataPresenter") ?? $"DataPresenter{theme}";
        var dpPrimitives = CompiledThemeClass(files, ".xamDataPresenter.xaml", "Primitives") ?? $"Primitives{theme}";
        var dockClass = CompiledThemeClass(files, ".xamDockManager.xaml", "DockManager") ?? $"DockManager{theme}";
        var dockPrimitives = CompiledThemeClass(files, ".xamDockManager.xaml", "Primitives") ?? dpPrimitives;
        var colorsFile = ThemeFile(files, theme, ".Theme.Colors.xaml");
        var stylesFile = ThemeFile(files, theme, ".Styles.xaml");
        var chartFile = ThemeFile(files, theme, ".xamDataChart.xaml");
        var msFile = ThemeFile(files, theme, ".MSControls.Core.Implicit.xaml");

        return $$$"""
            ## How to recolor {{{theme}}} (verified)

            Read the palette above as a **map** of which color plays which role, and use it to pick matching replacement colors. **Overriding these keys does not recolor the theme**: every theme file merges its own private copy of `{{{colorsFile}}}` and resolves the keys against it, and ThemeManager adds its dictionary after the app's resources. Verified in test apps on RoyalDark and IG for charts, grids, gauges, DockManager and standard WPF controls; all ThemeManager themes are built the same way.

            **Never works**
            - Overriding the palette keys (`Color_…`, `Brush01`–`Brush05`): the theme files never read your copy.
            - Putting overrides in a ResourceDictionary that App.xaml merges (`Application.Resources.MergedDictionaries`): ThemeManager's dictionary is added after it and wins.
            - ResourceWasher: it tints every color (backgrounds too), can't hit an exact brand color, and crashes on the compiled grid theme. The Infragistics Color Tuner only generates ResourceWashers merged in App.xaml, so it doesn't work either.

            **Where overrides work:** on the control itself, in the control's or window's `Resources`, or in a dictionary added in code **after** the theme is set (verified for the gauge, standard controls and DockManager):
            ```csharp
            Infragistics.Themes.ThemeManager.ApplicationTheme = new Infragistics.Themes.{{{themeClass}}}();
            Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("BrandColors.xaml", UriKind.Relative) });
            ```
            For the grid and DockManager, overrides placed directly in `Application.Resources` (not in a merged dictionary) work too.

            ### Recolor specific controls
            - **Chart (`XamCategoryChart`):** set `Brushes` and `Outlines` (each an `ig:BrushCollection`) on the chart.
            - **Grid (`XamDataGrid`):** Styles based on the theme's own grid styles, in the grid's `Resources` or directly in `Application.Resources`:
              ```xml
              <!-- xmlns:igThemes="http://infragistics.com/Themes" -->
              <Style TargetType="igDP:CellValuePresenter" BasedOn="{x:Static igThemes:{{{dpClass}}}.CellValuePresenter}">
                <Setter Property="BackgroundSelected" Value="#FF005BA0" />
                <Setter Property="BackgroundActive" Value="#FF005BA0" />
                <Setter Property="BackgroundFieldSelected" Value="#FF005BA0" />
              </Style>
              <Style TargetType="igDP:DataRecordCellArea" BasedOn="{x:Static igThemes:{{{dpClass}}}.DataRecordCellArea}">
                <Setter Property="BackgroundSelected" Value="#FF005BA0" />
                <Setter Property="BackgroundActive" Value="#FF005BA0" />
              </Style>
              ```
              Excel-style filter checkboxes need their own implicit `HierarchicalDataTemplate DataType="{x:Type igDP:RecordFilterTreeItem}"` with a CheckBox style. Check the text contrast too: light themes such as IG keep dark selected text, so also set `ForegroundSelectedStyle`, `ForegroundActiveStyle` and (on `CellValuePresenter`) `ForegroundFieldSelectedStyle` to a style with a readable `TextBlock.Foreground`.
            - **DockManager:** override its brush keys (`igDock:DockManagerBrushKeys`, xmlns `http://infragistics.com/DockManager`) app-wide — directly in `Application.Resources` or in a dictionary added after the theme. On RoyalDark, `TabbedDocumentActiveOuterBorderFillKey` draws the selected tab line and `MenuItemCheckmarkBoxHottrackCenterFillKey` the checked menu item; every key and its color is in `DefaultStyles/DockManager/{{{dockClass}}}_Brushes.xaml`. Overrides on the `XamDockManager` itself miss floating windows.
            - **Gauge (`XamRadialGauge`):** set `RangeBrushes` on the gauge. For an app-wide gauge Style (`BasedOn="{StaticResource {x:Type ig:XamRadialGauge}}"`), load the gauge type right after setting the theme — `System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(typeof(Infragistics.Controls.Gauges.XamRadialGauge).TypeHandle);` — or the gauge silently loses the theme.
            - **Standard WPF controls (Button, CheckBox, RadioButton, ListBoxItem, TextBox):** re-declaring the theme's brush keys near the control does nothing — the templates hold frozen brushes. Copy the control's template from `{{{stylesFile}}}` with the accent brushes swapped, or use the extended theme below. A `ProgressBar` only needs `Foreground`. A Button shows the accent only when focused or pressed.

            ### Recolor the whole app (extended theme)
            Subclass the theme and point ThemeManager at copied, recolored theme files:
            ```csharp
            public class BrandTheme : Infragistics.Themes.{{{themeClass}}}
            {
                protected override void ConfigureControlMappings()
                {
                    base.ConfigureControlMappings();
                    var chart = BuildLocationString(typeof(BrandTheme).Assembly.FullName, "/Themes/Brand/{{{chartFile}}}");
                    foreach (var key in Mappings.Keys.ToList())
                        if (Mappings[key].EndsWith("{{{chartFile}}}", StringComparison.OrdinalIgnoreCase)) // compare case-insensitively: registered names can differ in case
                            Mappings[key] = chart;
                }
            }
            // App.xaml.cs: Infragistics.Themes.ThemeManager.ApplicationTheme = new BrandTheme();
            ```
            - **Charts, gauges, standard controls and other controls:** copy the control's theme file and the files it merges (such as `{{{stylesFile}}}` and `{{{colorsFile}}}`) into your project, change the accent colors in the copied `{{{colorsFile}}}`, and remap that file as above. Standard WPF controls use `{{{msFile}}}`.
            - **Grid:** its theme file only wraps compiled themes. Remap it to your own dictionary that merges `<igThemes:{{{dpPrimitives}}} />` plus copies of the grid's theme files from `DefaultStyles/DataPresenter/` — `{{{dpClass}}}.xaml`, `{{{dpClass}}}_Express.xaml`, `{{{dpClass}}}_Brushes.xaml` and the `DataPresenterGeneric*.xaml` files they merge, with the `Images` folder as `Resource` items — and change the accent in the copied `{{{dpClass}}}_Brushes.xaml`. If the Excel-style filter checkboxes keep the old color (seen on IG), they are styled by the standard-controls file, `{{{msFile}}}` — remap that too.
            - **DockManager:** remap its file to a dictionary that merges `<igThemes:{{{dockPrimitives}}} />`, `<igThemes:{{{dockClass}}} />` and your brush-key overrides — no copied templates needed.
            - Copied theme files must be re-copied on every Infragistics upgrade. `get_wpf_theme_resource` returns them, but files over 24,000 characters are cut off; the full sources are in the Infragistics/wpf-resources repository on GitHub.

            _Read-only tool: it returns the theme's real keys and verified steps; it does not modify your project._
            """;
    }

    private static string BuildPaletteChooser(IEnumerable<string> themeNames) => string.Join('\n', new[]
        {
            "# WPF Theme Palettes — pick a base theme",
            "",
            "These ThemeManager themes have a color palette:",
            "",
        }
        .Concat(themeNames.Select(t => $"- `{t}`"))
        .Concat(new[]
        {
            "",
            "## To recolor WITHOUT knowing the theme name",
            "",
            "1. **Detect the theme the app already uses** from the workspace, in priority order:",
            "   - `App.xaml.cs` → `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` (the IG theme's class is `IgTheme`)",
            "   - the `.csproj` → an `Infragistics.WPF.Themes.<Name>.Trial` PackageReference",
            "   - XAML → a `Theme=\"<Name>\"` attribute",
            "2. If you cannot detect it, **ask the user** which base theme they want — or simply whether they want a **dark** base (e.g. `MetroDark`, `RoyalDark`) or a **light** base (e.g. `Office2013`, `RoyalLight`, `Metro`, `IG`). _This tool cannot classify dark/light automatically — the palette files are not consistent enough to derive it reliably._",
            "3. Call `get_wpf_theme_palette(theme)` with the chosen name to get its colors plus the verified recolor steps for that theme.",
            "",
            "_Overriding the palette keys does not recolor a theme; the steps returned in step 3 say what does. Concrete colors the user gives (e.g. \"neon purple\") are mapped to hex by you — use the palette to see which colors play which role._",
        }));

    [McpServerTool(Name = "get_wpf_theme_palette", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfThemePalette)]
    public CallToolResult GetThemePalette(
        [Description("""
            A newer-family (ThemeManager) theme name, e.g. "MetroDark", "RoyalDark", "RoyalLight",
                  "Office2013", "Office2010Blue", "Metro", "IG". Case-insensitive; a substring is accepted.
                  Returns that theme's color/brush palette (its `<Theme>.Theme.Colors.xaml`) as a map of which color
                  plays which role, plus the verified steps to recolor that theme (overriding the palette keys does NOT
                  recolor it).
                  OMIT this to get the chooser: the list of palette-capable theme names plus how to detect which theme
                  the app already uses. Detect the current theme from the workspace FIRST (App.xaml.cs
                  `ThemeManager.ApplicationTheme = new <Name>Theme();` or `new IgTheme()`, an `Infragistics.WPF.Themes.<Name>.Trial`
                  PackageReference, or a `Theme="<Name>"` attribute); if you cannot, ask the user which base theme
                  (or dark vs light) they want, then call again with that theme.
            """)]
        [MaxLength(64)]
        string? theme = null,
        [Description("""
            Optional substring filter matched against the palette group label (e.g. "accent", "error",
                  "chart", "base", "gauge"), the resource key (e.g. "Color_024", "Brush01"), the color value
                  (e.g. "00AADE", "#FF333333"), or an entry's note.
                  Case-insensitive. Omit to return the full palette. Ignored when `theme` is omitted.
            """)]
        [MaxLength(64)]
        string? filter = null)
    {
        var timer = Stopwatch.StartNew();
        var input = new { theme, filter };
        var available = ThemesWithPalette();

        if (string.IsNullOrWhiteSpace(theme))
        {
            var chooser = BuildPaletteChooser(available.Select(t => t.theme));
            log.Write("get_wpf_theme_palette", input, chooser, timer);
            return ToolResult.Text(chooser);
        }

        var themeFilter = theme.ToLowerInvariant().Trim();
        var exact = available.FirstOrDefault(t => t.theme.ToLowerInvariant() == themeFilter);
        var substringMatches = available.Where(t => t.theme.ToLowerInvariant().Contains(themeFilter, StringComparison.Ordinal)).ToArray();
        var match = exact.file is not null ? exact : substringMatches.FirstOrDefault();

        if (match.file is null)
        {
            var names = string.Join(", ", available.Select(t => $"`{t.theme}`"));
            var msg = $"No color palette found for theme \"{theme}\". Themes with a color palette (newer ThemeManager family): {names}. Call setup_wpf_theme to browse all themes and style folders.";
            log.Write("get_wpf_theme_palette", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var xaml = store.LoadThemeResource(match.file.Path);
        if (xaml is null)
        {
            var msg = $"Palette file \"{match.file.Path}\" for theme \"{match.theme}\" could not be read.";
            log.Write("get_wpf_theme_palette", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var entries = ParsePalette(xaml);
        var filterLower = filter?.ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(filterLower)) filterLower = null;
        if (filterLower is not null)
        {
            entries = entries.Where(e =>
                e.Group.ToLowerInvariant().Contains(filterLower, StringComparison.Ordinal) ||
                e.Key.ToLowerInvariant().Contains(filterLower, StringComparison.Ordinal) ||
                e.Value.ToLowerInvariant().Contains(filterLower, StringComparison.Ordinal) ||
                e.Note?.ToLowerInvariant().Contains(filterLower, StringComparison.Ordinal) == true).ToList();
        }

        if (entries.Count == 0)
        {
            var msg = filterLower is not null
                ? $"Theme \"{match.theme}\" has a palette, but no entries matched filter \"{filter}\". Omit `filter` to see the full palette."
                : $"Theme \"{match.theme}\" palette file parsed to zero entries (unexpected format).";
            log.Write("get_wpf_theme_palette", input, msg, timer);
            return ToolResult.Error(msg);
        }

        // First-seen group order for stable output.
        var byGroup = entries.GroupBy(e => e.Group).ToArray();

        var output = new List<string>
        {
            $"# WPF Theme Palette — {match.theme} ({entries.Count} entr{(entries.Count == 1 ? "y" : "ies")}{(filterLower is not null ? $", filter \"{filter}\"" : "")})",
            "",
            $"Source: `{match.file.Path}`",
        };

        if (exact.file is null && substringMatches.Length > 1)
        {
            var others = string.Join(", ", substringMatches.Skip(1).Select(t => $"`{t.theme}`"));
            output.Add("");
            output.Add($"> ⚠️ \"{theme}\" matched {substringMatches.Length} themes; showing **{match.theme}**. Other matches: {others}. Pass an exact theme name to pick a different one.");
        }

        foreach (var g in byGroup)
        {
            output.Add("");
            output.Add($"## {g.Key}");
            output.Add("");
            output.Add("| Key | Value | Notes |");
            output.Add("| --- | --- | --- |");
            foreach (var e in g)
                output.Add($"| `{e.Key}` | `{e.Value}`{(e.Kind == "Brush" ? " _(brush)_" : "")} | {e.Note ?? ""} |");
        }

        var themeFiles = store.ThemeIndex.NewerThemes.First(t => t.Theme == match.theme).Files;
        output.Add("");
        output.Add(RecolorGuidance(match.theme, themeFiles));

        var text = string.Join('\n', output);
        log.Write("get_wpf_theme_palette", input, text, timer);
        return ToolResult.Text(text);
    }
}
