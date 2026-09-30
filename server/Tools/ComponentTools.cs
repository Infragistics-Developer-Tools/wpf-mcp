using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Infragistics.Wpf.Mcp.Data;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Infragistics.Wpf.Mcp.Tools;

[McpServerToolType]
public sealed partial class ComponentTools(DataStore store, ToolLog log)
{
    // ── list_wpf_components ──────────────────────────────────────────────────

    [McpServerTool(Name = "list_wpf_components", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.ListWpfComponents)]
    public CallToolResult ListComponents(
        [Description("""
            Optional keyword to filter by component name, description, or NuGet package.
                  Case-insensitive. Examples: "grid", "chart", "dock", "editor". Omit to return all.
            """)]
        [MaxLength(128)]
        string? filter = null)
    {
        var timer = Stopwatch.StartNew();
        var input = new { filter };
        var components = store.Components;

        // Same relevance ladder as handlers.ts: name match always outranks a description or
        // package-only match, ties broken alphabetically.
        static double MatchScore(ComponentEntry c, string needle)
        {
            var name = c.Component.ToLowerInvariant();
            if (name == needle) return 4;
            if (name.StartsWith(needle, StringComparison.Ordinal)) return 3;
            if (name.Contains(needle, StringComparison.Ordinal)) return 2;
            if (c.Description.ToLowerInvariant().Contains(needle, StringComparison.Ordinal)) return 1;
            if (c.NugetPackage.ToLowerInvariant().Contains(needle, StringComparison.Ordinal)) return 0.5;
            return 0;
        }

        ComponentEntry[] matches;
        if (!string.IsNullOrEmpty(filter))
        {
            var needle = filter.ToLowerInvariant();
            matches = components
                .Select(c => (c, score: MatchScore(c, needle)))
                .Where(m => m.score > 0)
                .OrderByDescending(m => m.score)
                .ThenBy(m => m.c.Component, NameComparer.Instance)
                .Select(m => m.c)
                .ToArray();
        }
        else
        {
            matches = components;
        }

        if (matches.Length == 0)
        {
            var msg = $"No components found matching \"{filter}\". Call list_wpf_components without a filter to see all {components.Length} available components.";
            log.Write("list_wpf_components", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var lines = matches.Select(c =>
        {
            var line = new List<string>
            {
                $"## {c.Component}",
                $"- **xmlns:** `xmlns:{c.DefaultPrefix}=\"{c.XamlNamespace}\"`",
                $"- **NuGet:** `{c.NugetPackage}`",
                $"- **Assembly:** `{c.Assembly}`",
                $"- {c.Description}",
            };
            if (ThemeLookup.IsThemeable(c.Component, store.ThemeIndex))
                line.Add($"- 🎨 Ships with named themes — call `setup_wpf_theme(component: \"{c.Component}\")` before writing style/theme overrides.");
            return string.Join('\n', line);
        });

        var header = $"# Infragistics WPF Components ({matches.Length}{(string.IsNullOrEmpty(filter) ? " total" : $" matching \"{filter}\"")})";
        var text = string.Join("\n\n", new[] { header, "" }.Concat(lines));

        log.Write("list_wpf_components", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_api_reference ────────────────────────────────────────────────

    private static string FormatMember(ApiMemberEntry m)
    {
        var line = $"- **{m.Name}**";
        if (!string.IsNullOrEmpty(m.TypeName))
        {
            line += $" `{m.TypeName}`";
            if (m.IsEnum == true && m.EnumValues is { Length: > 0 })
                line += $" — values: `{string.Join("` | `", m.EnumValues)}`";
        }
        line += $": {(string.IsNullOrEmpty(m.Summary) ? "—" : m.Summary)}";
        return line;
    }

    [McpServerTool(Name = "get_wpf_api_reference", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfApiReference)]
    public CallToolResult GetApiReference(
        [Description("""
            Any Infragistics WPF type name — 7000+ types including controls (e.g. "XamDataGrid"),
                  supporting types (e.g. "FieldLayout", "SummaryDefinition"), enums, strategies, indicators, and more.
                  Case-insensitive. To find a Xam* control name use list_wpf_components. To discover any other type name use search_wpf_api.
            """)]
        [MinLength(1), MaxLength(128)]
        string component,
        [Description("""Member category to return. Defaults to "all". Use a specific category when the user asks only about properties, methods, or events.""")]
        MemberKind kind = MemberKind.all)
    {
        var timer = Stopwatch.StartNew();
        var input = new { component, kind = kind.ToString() };

        var doc = store.LoadApiDoc(component);
        if (doc is null)
        {
            var known = string.Join(", ", store.Components.Select(c => c.Component));
            var msg = $"Component \"{component}\" not found. Known Xam* controls: {known}\n\nNote: Supporting types (FieldLayout, SummaryDefinition, etc.) are also available — use the exact type name.";
            log.Write("get_wpf_api_reference", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var allMembers = doc.Properties.Select(m => (m, kind: "property"))
            .Concat(doc.Events.Select(m => (m, kind: "event")))
            .Concat(doc.Methods.Select(m => (m, kind: "method")))
            .ToArray();
        var wanted = kind switch
        {
            MemberKind.properties => "property",
            MemberKind.events => "event",
            MemberKind.methods => "method",
            _ => null,
        };
        var members = wanted is null ? allMembers : allMembers.Where(m => m.kind == wanted).ToArray();

        var summary = string.IsNullOrEmpty(doc.Summary) ? "_(no summary)_" : doc.Summary;
        var output = new List<string>
        {
            $"# {doc.Component}",
            "",
            $"**xmlns:** `xmlns:{doc.DefaultPrefix}=\"{doc.XamlNamespace}\"`",
            $"**NuGet:** `{doc.NugetPackage}`",
            $"**Assembly:** `{doc.Assembly}`",
            $"**Full type name:** `{doc.DotnetNamespace}.{doc.Component}`",
            "",
            "## Summary",
            summary,
        };

        if (doc.Alternates is { Length: > 0 })
        {
            var memberCount = doc.Properties.Length + doc.Events.Length + doc.Methods.Length;
            output.Add("");
            output.Add($"⚠️ **\"{doc.Component}\" is ambiguous** — {doc.Alternates.Length} other Infragistics type(s) share this name, each in a different namespace/package with its own xmlns. This page documents `{doc.DotnetNamespace}.{doc.Component}` ({memberCount} members), the most fully documented one. The others are not indexed separately:");
            output.AddRange(doc.Alternates.Select(a => $"- `{a.FullName}` — {a.MemberCount} members, NuGet `{a.NugetPackage}`"));
            output.Add("If the members below don't match the control you're using, you're likely on the other type — confirm which package/xmlns your project references before writing XAML.");
        }

        if (!string.IsNullOrEmpty(doc.Remarks))
        {
            output.Add("");
            output.Add("## Remarks");
            output.Add(doc.Remarks);
        }

        var hasAny = false;
        foreach (var (label, kindKey) in new[] { ("Properties", "property"), ("Events", "event"), ("Methods", "method") })
        {
            var items = members.Where(m => m.kind == kindKey).Select(m => m.m).ToArray();
            if (items.Length == 0) continue;
            hasAny = true;

            // Direct members first, then one section per ancestor in first-seen order.
            var direct = items.Where(m => string.IsNullOrEmpty(m.DeclaredOn)).ToArray();
            var inherited = items.Where(m => !string.IsNullOrEmpty(m.DeclaredOn)).GroupBy(m => m.DeclaredOn!);

            if (direct.Length > 0)
            {
                output.Add("");
                output.Add($"## {label}");
                output.AddRange(direct.Select(FormatMember));
            }
            foreach (var group in inherited)
            {
                output.Add("");
                output.Add($"## {label} (inherited from `{group.Key}`)");
                output.AddRange(group.Select(FormatMember));
            }
        }

        if (!hasAny)
        {
            var baseHint = !string.IsNullOrEmpty(doc.BaseType)
                ? $"Call get_wpf_api_reference(\"{doc.BaseType}\") to see the inherited API surface."
                : "This type has no recorded base type in the registry — it may be a leaf/root type with no further members to inherit.";
            output.Add("");
            output.Add($"_No {(kind == MemberKind.all ? "" : kind + " ")}members defined directly on this type._");
            output.Add($"_This type's own API surface is empty or was filtered by \"kind\". {baseHint}_");
        }

        // Theming hint only when the type has Brush-typed members AND ships with named themes.
        var brushMembers = allMembers.Where(m => m.m.TypeName?.Contains("Brush", StringComparison.Ordinal) == true).Select(m => m.m).ToArray();
        if (brushMembers.Length > 0 && ThemeLookup.IsThemeable(doc.Component, store.ThemeIndex))
        {
            var examples = string.Join(", ", brushMembers.Take(3).Select(m => $"`{m.Name}`"));
            output.Add("");
            output.Add($"_⚠️ This type has Brush-typed properties (e.g. {examples}) and ships with named themes. Before setting these directly or writing Style/ControlTemplate overrides, call `setup_wpf_theme(component: \"{doc.Component}\")` to check whether a named theme (`Theme=\"...\"` or `ThemeManager`) already covers this, and to get exact resource file paths for customizing it._");
        }

        var text = string.Join('\n', output);
        log.Write("get_wpf_api_reference", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_project_scaffold ─────────────────────────────────────────────

    [GeneratedRegex("^[a-zA-Z][a-zA-Z0-9._-]*$")]
    private static partial Regex ProjectNameRegex();

    [McpServerTool(Name = "get_wpf_project_scaffold", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfProjectScaffold)]
    public CallToolResult GetProjectScaffold(
        [Description("""
            List of Infragistics WPF component names to include in the project.
                  Call list_wpf_components first to resolve exact names.
                  Examples: ["XamDataGrid", "XamCategoryChart"], ["XamDockManager"].
            """)]
        [MinLength(1)]
        string[] components,
        [Description(""".NET project name. Defaults to "MyWpfApp".""")]
        [MinLength(1), MaxLength(128)]
        string projectName = "MyWpfApp",
        [Description("""Target framework version. Defaults to "net8.0".""")]
        TargetFramework framework = TargetFramework.net8_0)
    {
        var timer = Stopwatch.StartNew();
        var input = new { components, projectName, framework = framework.Wire() };

        if (!ProjectNameRegex().IsMatch(projectName))
        {
            var msg = $"Invalid project name \"{projectName}\". Project names must start with a letter and contain only letters, digits, dots, underscores, or hyphens.";
            log.Write("get_wpf_project_scaffold", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var resolved = new List<(string component, string nugetPackage, string xmlns)>();
        var notFoundWarnings = new List<string>();

        foreach (var name in components)
        {
            var nameLower = name.ToLowerInvariant();
            var entry = store.Components.FirstOrDefault(c => c.Component.ToLowerInvariant() == nameLower);
            if (entry is null)
            {
                var suggestions = store.Components
                    .Where(c => c.Component.ToLowerInvariant().Contains(nameLower, StringComparison.Ordinal))
                    .Select(c => c.Component)
                    .Take(5)
                    .ToArray();
                var hint = suggestions.Length > 0
                    ? $" Did you mean: {string.Join(", ", suggestions.Select(s => $"`{s}`"))}? Call `list_wpf_components(filter: \"{name}\")` to browse options."
                    : " Call `list_wpf_components` to browse all available component names.";
                notFoundWarnings.Add($"`{name}` not found in registry.{hint}");
            }
            else
            {
                resolved.Add((entry.Component, entry.NugetPackage, $"xmlns:{entry.DefaultPrefix}=\"{entry.XamlNamespace}\""));
            }
        }

        if (resolved.Count == 0)
        {
            var msg =
                "Cannot generate scaffold — none of the requested components were found in the registry.\n\n" +
                string.Join('\n', notFoundWarnings.Select(w => $"- {w}")) +
                "\n\nCall `list_wpf_components` (with an optional filter keyword) to get exact component names, " +
                "then call `get_wpf_project_scaffold` again with the correct names.";
            log.Write("get_wpf_project_scaffold", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var uniquePackages = resolved.Select(r => r.nugetPackage).Distinct().ToArray();
        var uniqueXmlns = resolved.Select(r => r.xmlns).Distinct().ToArray();

        var lines = new List<string>();

        if (notFoundWarnings.Count > 0)
        {
            lines.Add("> **Warning:** Some components were not found and were skipped:");
            lines.AddRange(notFoundWarnings.Select(w => $"> - {w}"));
            lines.Add("");
        }

        lines.Add($"# WPF Project Scaffold: `{projectName}`");
        lines.Add("");
        lines.Add("## 1. Create and configure the project");
        lines.Add("");
        lines.Add("```bash");
        lines.Add($"dotnet new wpf -n {projectName} --framework {framework.Wire()}");
        lines.Add($"cd {projectName}");
        lines.AddRange(uniquePackages.Select(pkg => $"dotnet add package {pkg}"));
        lines.Add("dotnet restore");
        lines.Add("```");
        lines.Add("");
        lines.Add("## 2. Add xmlns declarations to MainWindow.xaml");
        lines.Add("");
        lines.Add("```xml");
        lines.Add("<Window ...");
        lines.AddRange(uniqueXmlns.Select(x => $"        {x}"));
        lines.Add(">");
        lines.Add("```");

        lines.Add("");
        lines.Add("## Components resolved");
        lines.AddRange(resolved.Select(r => $"- **{r.component}** → `{r.nugetPackage}`"));

        var text = string.Join('\n', lines);
        log.Write("get_wpf_project_scaffold", input, text, timer);
        return ToolResult.Text(text);
    }
}
