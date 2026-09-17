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
        "_Newer family (`Themes/`): apply via `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` in App.xaml.cs (requires the `Infragistics.WPF.Themes.<Name>.Trial` NuGet package). Do NOT merge these files directly into `Application.Resources`._";

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
        "// App.xaml.cs — set before the first window is created",
        "Infragistics.Themes.ThemeManager.ApplicationTheme = new Infragistics.Themes.<Name>Theme();",
        "```",
    });

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
        $"    Infragistics.Themes.ThemeManager.ApplicationTheme = new Infragistics.Themes.{theme}Theme();",
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
            ? "_Newer family: apply via `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();` — do not merge this file directly into Application.Resources._"
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

    private static readonly string PaletteGuidance = string.Join('\n', new[]
    {
        "## How to apply a re-tuned palette",
        "",
        "These keys are the single re-color surface for the **newer \"Infragistics.Controls.*\" family** (charts, gauges, etc.) applied via `Infragistics.Themes.ThemeManager`. To recolor the theme WITHOUT creating a new theme, override just the keys you want in your own `ResourceDictionary` and merge it into the theme load — do NOT invent new keys or rename existing ones.",
        "",
        "⚠️ **Load-order matters.** The theme references these colors from compiled BAML primitives via `StaticResource` (resolved once at parse time), so merging an override dictionary *after* the theme has already loaded may NOT recolor already-styled controls. Merge your override so it is present BEFORE `ThemeManager.ApplicationTheme` is set / before the first themed window is created (e.g. in `App.xaml.cs` before `base.OnStartup`).",
        "",
        "⚠️ **Newer family only.** Legacy \"Infragistics.Windows.*\" controls (XamDataGrid, XamRibbon, XamDockManager, ...) do NOT read this palette — their themes are embedded BAML applied via `Theme=\"...\"`. Recolor those by copying individual Styles/ControlTemplates (see `setup_wpf_theme` / `get_wpf_theme_resource`).",
        "",
        "_This is a read-only introspection tool — it returns the real keys/values and a skeleton to copy; it does not modify your project._",
    });

    private static string BuildPaletteChooser(IEnumerable<string> themeNames) => string.Join('\n', new[]
        {
            "# WPF Theme Palettes — pick a base theme",
            "",
            "These newer-family (ThemeManager) themes expose a re-tunable color palette:",
            "",
        }
        .Concat(themeNames.Select(t => $"- `{t}`"))
        .Concat(new[]
        {
            "",
            "## To re-color WITHOUT knowing the theme name",
            "",
            "1. **Detect the theme the app already uses** from the workspace, in priority order:",
            "   - `App.xaml.cs` → `Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();`",
            "   - the `.csproj` → an `Infragistics.WPF.Themes.<Name>.Trial` PackageReference",
            "   - XAML → a `Theme=\"<Name>\"` attribute",
            "2. If you cannot detect it, **ask the user** which base theme they want — or simply whether they want a **dark** base (e.g. `MetroDark`, `RoyalDark`) or a **light** base (e.g. `Office2013`, `RoyalLight`, `Metro`, `IG`). _This tool cannot classify dark/light automatically — the palette files are not consistent enough to derive it reliably._",
            "3. Call `get_wpf_theme_palette(theme)` with the chosen name to get its keys + a ready-to-merge override skeleton.",
            "",
            "_Concrete colors the user gives (e.g. \"neon purple\") are mapped to hex and assigned to the returned accent/chart-series keys by you — the tool only supplies the grounded keys._",
        }));

    [McpServerTool(Name = "get_wpf_theme_palette", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfThemePalette)]
    public CallToolResult GetThemePalette(
        [Description("""
            A newer-family (ThemeManager) theme name, e.g. "MetroDark", "RoyalDark", "RoyalLight",
                  "Office2013", "Office2010Blue", "Metro", "IG". Case-insensitive; a substring is accepted.
                  Returns that theme's centralized color/brush palette (its `<Theme>.Theme.Colors.xaml`) so you can
                  re-color the theme by overriding existing keys — NOT create a new theme.
                  OMIT this to get the chooser: the list of palette-capable theme names plus how to detect which theme
                  the app already uses. Detect the current theme from the workspace FIRST (App.xaml.cs
                  `ThemeManager.ApplicationTheme = new <Name>Theme();`, an `Infragistics.WPF.Themes.<Name>.Trial`
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
            var msg = $"No re-tunable palette found for theme \"{theme}\". Themes with a color palette (newer ThemeManager family): {names}. Call setup_wpf_theme to browse all themes and style folders.";
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

        output.Add("");
        output.Add("## Override skeleton");
        output.Add("");
        output.Add("_Copy into a `ResourceDictionary`, change only the values you want, and merge it ahead of the theme load (see guidance below). Delete rows you are not changing._");
        output.Add("");
        output.Add("```xml");
        output.Add("<ResourceDictionary xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"");
        output.Add("                    xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">");
        foreach (var g in byGroup)
        {
            output.Add($"  <!-- {g.Key} -->");
            foreach (var e in g)
                output.Add(e.Kind == "Brush"
                    ? $"  <SolidColorBrush x:Key=\"{e.Key}\" Color=\"{e.Value}\" />"
                    : $"  <Color x:Key=\"{e.Key}\">{e.Value}</Color>");
        }
        output.Add("</ResourceDictionary>");
        output.Add("```");

        output.Add("");
        output.Add(PaletteGuidance);

        var text = string.Join('\n', output);
        log.Write("get_wpf_theme_palette", input, text, timer);
        return ToolResult.Text(text);
    }
}
