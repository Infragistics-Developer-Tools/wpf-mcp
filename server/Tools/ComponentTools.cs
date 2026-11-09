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
        if (ToolInput.CheckLength("filter", filter, max: 128) is { } invalid)
        {
            log.Write("list_wpf_components", input, invalid, timer);
            return ToolResult.Error(invalid);
        }
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
                $"### {c.Component}",
                $"- **xmlns:** `xmlns:{c.DefaultPrefix}=\"{c.XamlNamespace}\"`",
                $"- **NuGet:** `{c.NugetPackage}`",
                $"- **Assembly:** `{c.Assembly}`",
                $"- {c.Description}",
            };
            // Another control of this name (the newer Infragistics.Controls.Editors.XamComboEditor), which only its full name opens.
            line.AddRange((c.Alternates ?? []).Select(a =>
                $"- ⚠️ Not the only {c.Component}: `{a.FullName}` is another (NuGet `{a.NugetPackage}`, `xmlns:{a.DefaultPrefix}=\"{a.XamlNamespace}\"`; " +
                $"get_wpf_api_reference(\"{a.Lookup}\")). The name alone means the one above in get_wpf_api_reference and get_wpf_project_scaffold."));
            if (ThemeLookup.IsThemeable(c.Component, store.ThemeIndex))
                line.Add($"- 🎨 Ships with named themes — call `setup_wpf_theme(component: \"{c.Component}\")` before writing style/theme overrides.");
            return string.Join('\n', line);
        });

        var header = $"## Infragistics WPF Components ({matches.Length}{(string.IsNullOrEmpty(filter) ? " total" : $" matching \"{filter}\"")})";
        var text = string.Join("\n\n", new[] { header, "" }.Concat(lines));

        log.Write("list_wpf_components", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_api_reference ────────────────────────────────────────────────

    // A Markdown code span, double-fenced when the text has a backtick of its own (a generic type's "EnumWrapper`1"),
    // which would otherwise end the span and cut a call in two.
    private static string Code(string text) => text.Contains('`') ? $"`` {text} ``" : $"`{text}`";

    // One line per other type of the page's short name: the call that opens it, then what tells them apart.
    private static string FormatAlternate(AlternateType a, string shortName)
    {
        var size = a.ValueCount is { } count
            ? $"{count} values ({string.Join(", ", (a.ValueNames ?? []).Select(v => $"`{v}`"))}{(count > (a.ValueNames?.Length ?? 0) ? ", …" : "")})"
            : $"{a.MemberCount} members";
        var xmlns = a.XamlNamespace is { } ns ? $", `xmlns:{a.DefaultPrefix}=\"{ns}\"`" : "";
        var isDefault = a.IsDefault == true ? $" (what \"{shortName}\" alone returns)" : "";
        return $"- {Code($"get_wpf_api_reference(\"{a.Lookup}\")")}{isDefault} — {size}, NuGet `{a.NugetPackage}`{xmlns}: {(string.IsNullOrEmpty(a.Summary) ? "—" : a.Summary)}";
    }

    private static string FormatMember(ApiMemberEntry m, bool withParameters)
    {
        // A signature names the type itself: "void Export(OutputFormat outputFormat)", "double this[int index]", "protected"
        // and "int?" included. Otherwise a Nullable<T> comes as TypeName T with IsNullable set.
        var line = m.Signature is { } signature ? $"- `{signature}`" : $"- **{m.Name}**";
        if (m.Signature is null && !string.IsNullOrEmpty(m.TypeName)) line += $" `{m.TypeName}{(m.IsNullable == true ? "?" : "")}`";
        // The XML docs list protected properties and events with the public ones (XamGrid.CurrentEditCell): CS0122 outside a subclass.
        if (m.Signature is null && m.IsProtected == true) line += " _(protected)_";
        if (m.IsEnum == true && m.EnumValues is { Length: > 0 })
            line += $" — values: `{string.Join("` | `", m.EnumValues)}`";
        if (m.IsField == true) line += " _(static field)_";
        line += $": {(string.IsNullOrEmpty(m.Summary) ? "—" : m.Summary)}";
        // Only with `member`: parameter descriptions tell overloads apart, but would double the size of a full listing.
        if (withParameters && m.Parameters is { Length: > 0 })
            line += string.Concat(m.Parameters.Select(p => $"\n  - `{p.Name}`: {p.Summary}"));
        return line;
    }

    // Above this size the full rendering gets saved to a file by clients like Claude Code instead
    // of coming back inline (~28K was seen inline, 56K was not). With the Infragistics 26.1.21 data
    // ~210 types exceed it, almost all because of members copied down from base classes.
    internal const int MaxApiReferenceChars = 25_000;

    // How much detail the member sections get, tried in this order; the first rendering that fits wins.
    // Properties keep full detail the longest because they are what XAML needs (types, enum values):
    // on the grids nearly every property is inherited, so compacting inherited members first would
    // hide exactly those. Events and methods are one `member` call away. Before the next level, a level is tried
    // with its protected properties and events by name only (protectedByName): only a subclass can use them, and
    // their types and markers would push the kind "properties" responses of 21 types (20 chart series and SeriesViewer)
    // past 25K and down to CompactInherited or lower.
    private enum ApiDetail { Full, CompactEventsMethods, CompactInherited, CompactAll }

    private static bool IsCompact(ApiDetail detail, string kindKey, bool inherited) => detail switch
    {
        ApiDetail.Full => false,
        ApiDetail.CompactEventsMethods => kindKey != "property",
        ApiDetail.CompactInherited => inherited,
        _ => true,
    };

    private static string CompactionSummary(ApiDetail detail, bool protectedByName) => (detail, protectedByName) switch
    {
        (ApiDetail.Full, _) => "protected properties and events are listed by name only (public members keep full detail)",
        (ApiDetail.CompactEventsMethods, false) => "events and methods are listed by name only (properties keep full detail)",
        (ApiDetail.CompactEventsMethods, true) => "events, methods and protected properties are listed by name only (public properties keep full detail)",
        (ApiDetail.CompactInherited, false) => "inherited members are listed by name only (members declared on this type keep full detail)",
        (ApiDetail.CompactInherited, true) => "inherited members and protected properties and events are listed by name only (public members declared on this type keep full detail)",
        _ => "all members are listed by name only",
    };

    // Properties and events carry the flag; methods (and indexers) say "protected" in their signature.
    private static bool IsProtected(ApiMemberEntry m) =>
        m.Signature is { } signature ? signature.StartsWith("protected ", StringComparison.Ordinal) : m.IsProtected == true;

    // What the protectedByName levels list by name: protected properties and events, whose full lines carry a type and a
    // marker. A protected method's full line is its signature, which says so already.
    private static bool IsProtectedMember(ApiMemberEntry m) => m.Signature is null && m.IsProtected == true;

    // Compact rendering: one line of names per section, an overloaded name once with its count; details come from a `member` call.
    // Protected members come last, after "protected:", so a name-only list doesn't pass them off as public; a method name
    // only when every overload listed is protected (one public overload makes the name callable).
    private static string FormatMemberNames(IEnumerable<ApiMemberEntry> items)
    {
        static string Names(IEnumerable<IGrouping<string, ApiMemberEntry>> groups) =>
            string.Join(", ", groups.Select(g => g.Count() > 1 ? $"`{g.Key}` ({g.Count()})" : $"`{g.Key}`"));
        var byName = items.GroupBy(m => m.Name).ToLookup(g => g.All(IsProtected));
        var open = Names(byName[false]);
        if (!byName.Contains(true)) return open;
        return $"{open}{(open.Length > 0 ? "; " : "")}protected: {Names(byName[true])}";
    }

    private static List<string> RenderMemberSections((ApiMemberEntry m, string kind)[] members, ApiDetail detail, bool protectedByName, bool withParameters)
    {
        var output = new List<string>();
        string Format(ApiMemberEntry m) => FormatMember(m, withParameters);
        IEnumerable<string> Detailed(ApiMemberEntry[] group) =>
            protectedByName && group.Any(IsProtectedMember)
                ? group.Where(m => !IsProtectedMember(m)).Select(Format).Append($"- {FormatMemberNames(group.Where(IsProtectedMember))}")
                : group.Select(Format);
        foreach (var (label, kindKey) in new[] { ("Constructors", "constructor"), ("Properties", "property"), ("Events", "event"), ("Methods", "method") })
        {
            var items = members.Where(m => m.kind == kindKey).Select(m => m.m).ToArray();
            if (items.Length == 0) continue;

            // Direct members first, then one section per ancestor in first-seen order.
            var direct = items.Where(m => string.IsNullOrEmpty(m.DeclaredOn)).ToArray();
            var inherited = items.Where(m => !string.IsNullOrEmpty(m.DeclaredOn)).GroupBy(m => m.DeclaredOn!);

            if (direct.Length > 0)
            {
                output.Add("");
                output.Add($"### {label}");
                if (IsCompact(detail, kindKey, inherited: false)) output.Add(FormatMemberNames(direct));
                else output.AddRange(Detailed(direct));
            }
            foreach (var group in inherited)
            {
                output.Add("");
                output.Add($"### {label} (inherited from `{group.Key}`)");
                if (IsCompact(detail, kindKey, inherited: true)) output.Add(FormatMemberNames(group));
                else output.AddRange(Detailed(group.ToArray()));
            }
        }
        return output;
    }

    // An enum's values in declaration order, with their numbers: "- **XPS** = 0: Exports to XPS format". A [Flags] enum
    // says how its values combine, with two of its own single-bit values as the example (without one when it has fewer:
    // LicenseOptions). Compact: names only (UTMZone has 1,197 values).
    private static List<string> RenderValues(ApiEntry doc, EnumValue[] values, bool compact)
    {
        if (values.Length == 0) return [];
        var output = new List<string> { "", "### Values" };
        if (doc.IsFlags == true)
        {
            var pair = values.Where(v => v.Obsolete is null && v.Value > 0 && (v.Value & (v.Value - 1)) == 0).Take(2).ToArray();
            output.Add(pair is [var a, var b]
                ? $"_[Flags] enum: values combine — `{doc.Component}.{a.Name} | {doc.Component}.{b.Name}` in C#, `\"{a.Name}, {b.Name}\"` in a XAML attribute._"
                : "_[Flags] enum: values combine with `|` in C#, comma-separated in a XAML attribute._");
        }
        if (compact) output.Add(string.Join(", ", values.Select(v => $"`{v.Name}`")));
        else output.AddRange(values.Select(v =>
            $"- **{v.Name}** = {v.Value}: {(string.IsNullOrEmpty(v.Summary) ? "—" : v.Summary)}" +
            (v.Obsolete is { } message ? $" ⚠ OBSOLETE: {(string.IsNullOrEmpty(message) ? "don't use it." : message)}" : "")));
        return output;
    }

    [McpServerTool(Name = "get_wpf_api_reference", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfApiReference)]
    public CallToolResult GetApiReference(
        [Description("""
            Any public Infragistics WPF type name — 5,100+ types including controls (e.g. "XamDataGrid"),
                  supporting types (e.g. "FieldLayout", "SummaryDefinition"), enums, strategies, indicators, and more.
                  Case-insensitive. To find a Xam* control name use list_wpf_components. To discover any other type name use search_wpf_api.
                  Or a full name (Namespace.Type), e.g. "Infragistics.Controls.Editors.XamComboEditor": a name several types share
                  returns the most fully documented one and lists the others with the full name that opens each.
            """)]
        [MinLength(1), MaxLength(128)]
        string component,
        [Description("""Member category to return. Defaults to "all". Use a specific category when the user asks only about properties, methods, or events. An enum's values come back with any kind.""")]
        MemberKind kind = MemberKind.all,
        [Description("""
            Optional member name filter — case-insensitive substring, combinable with "kind".
                  Returns only the matching members, including inherited ones, with full detail (type, enum values, summary;
                  for methods and constructors the signature of every overload and its parameter descriptions).
                  Examples: "YAxis" (every YAxis* member), "FieldLayout", "Changed". Use it to check specific members on a large type,
                  or to get details of members a compacted response lists by name only. On an enum it filters the values.
            """)]
        [MaxLength(128)]
        string? member = null)
    {
        var timer = Stopwatch.StartNew();
        var input = new { component, kind = kind.ToString(), member };
        if ((ToolInput.CheckLength("component", component, max: 128, min: 1) ?? ToolInput.CheckLength("member", member, max: 128)) is { } invalid)
        {
            log.Write("get_wpf_api_reference", input, invalid, timer);
            return ToolResult.Error(invalid);
        }
        var memberFilter = member?.Trim();

        var doc = store.LoadApiType(component, out var byShortName);
        if (doc is null)
        {
            var known = string.Join(", ", store.Components.Select(c => c.Component));
            // A full name whose short name has a page: the types of that name, as the page lists them.
            var msg = byShortName is { } page
                ? $"Type \"{component}\" not found. The Infragistics type(s) named \"{page.Component}\" — pass one of these exactly:\n" +
                  string.Join('\n', new[] { $"- {Code($"get_wpf_api_reference(\"{page.DotnetNamespace}.{page.Component}\")")} (what \"{page.Component}\" alone returns) — NuGet `{page.NugetPackage}`" }
                      .Concat((page.Alternates ?? []).Where(a => a.Lookup is not null).Select(a => $"- {Code($"get_wpf_api_reference(\"{a.Lookup}\")")} — NuGet `{a.NugetPackage}`")))
                : $"Component \"{component}\" not found. Known Xam* controls: {known}\n\nNote: Supporting types (FieldLayout, SummaryDefinition, etc.) are also available — use the exact type name.";
            log.Write("get_wpf_api_reference", input, msg, timer);
            return ToolResult.Error(msg);
        }
        // What opens this page again, for the hints below: the short name, or for a type that lost it, its full name.
        var self = doc.Lookup ?? doc.Component;

        var allMembers = (doc.Constructors ?? []).Select(m => (m, kind: "constructor"))
            .Concat(doc.Properties.Select(m => (m, kind: "property")))
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
        // kind "methods" covers constructors too.
        bool IsWanted(string memberKind) => wanted is null || memberKind == wanted || (wanted == "method" && memberKind == "constructor");
        var members = allMembers.Where(m => IsWanted(m.kind)).ToArray();

        var summary = string.IsNullOrEmpty(doc.Summary) ? "_(no summary)_" : doc.Summary;
        var output = new List<string> { $"## {doc.Component}", "" };
        // Old code and docs still use some [Obsolete] types (3 topics use UnboundField): say so before anything else.
        if (doc.ObsoleteMessage is { } obsoleteMessage)
            output.AddRange([$"⚠ **OBSOLETE type:** {(string.IsNullOrEmpty(obsoleteMessage) ? "don't use it in new code." : obsoleteMessage)}", ""]);
        output.Add($"**xmlns:** `xmlns:{doc.DefaultPrefix}=\"{doc.XamlNamespace}\"`");
        if (doc.XamlName is { } xamlName)
            output.Add($"**XAML name:** `{doc.DefaultPrefix}:{xamlName}` (nested class)");
        // clr-namespace names the assembly, and only the .NET (8+) builds are called Infragistics.WPF.*.
        if (doc.XamlNamespace.StartsWith("clr-namespace:", StringComparison.Ordinal) && doc.Assembly.StartsWith("Infragistics.WPF", StringComparison.Ordinal))
            output.Add($"_.NET Framework 4.x apps: use `assembly=InfragisticsWPF{doc.Assembly["Infragistics.WPF".Length..]}` (that build's assembly name)._");
        output.AddRange(new[]
        {
            $"**NuGet:** `{doc.NugetPackage}`",
            $"**Assembly:** `{doc.Assembly}`",
            $"**Full type name:** `{doc.DotnetNamespace}.{doc.Component}`",
            "",
            "### Summary",
            summary,
        });

        // The other types of this short name (an agent on XamDataGrid got XamGrid's SelectionType), each with the call that
        // opens it — its full name — and enough to choose: size, package, xmlns, what it is.
        var others = (doc.Alternates ?? []).Where(a => a.SameType != true).ToArray();
        if (others.Length > 0)
        {
            var memberCount = doc.Properties.Length + doc.Events.Length + doc.Methods.Length;
            // Member counts say nothing about enums, which have values instead (every one would read "0 members").
            var count = doc.Values is { } enumValues ? $"{enumValues.Length} values" : $"{memberCount} members";
            var which = doc.Lookup is null
                ? $"This page documents `{doc.DotnetNamespace}.{doc.Component}` ({count}), the most fully documented one, which \"{doc.Component}\" alone returns."
                : $"This page documents {Code(doc.Lookup)} ({count}); \"{doc.Component}\" alone returns the most fully documented one.";
            output.Add("");
            output.Add($"⚠️ **\"{doc.Component}\" is ambiguous** — {others.Length} other Infragistics type(s) share this name, each in a different namespace/package with its own xmlns. {which} To open another, pass its full name exactly as given:");
            output.AddRange(others.Select(a => FormatAlternate(a, doc.Component)));
            output.Add($"If the {(doc.Values is null ? "members" : "values")} below don't match the control you're using, you're likely on another type — confirm which package/xmlns your project references before writing XAML.");
        }
        // The same class listed under a second package (Infragistics.WPF.Spreadsheet.Charts.Trial ships the XML docs of
        // XamSpreadsheet's assembly): not another type, so no page of its own.
        if ((doc.Alternates ?? []).Where(a => a.SameType == true).Select(a => $"`{a.NugetPackage}`").ToArray() is { Length: > 0 } packages)
        {
            output.Add("");
            output.Add($"_The same class, from the same assembly, is also listed under NuGet {string.Join(", ", packages)}._");
        }

        if (!string.IsNullOrEmpty(doc.Remarks))
        {
            output.Add("");
            output.Add("### Remarks");
            output.Add(doc.Remarks);
        }

        var kindPrefix = kind == MemberKind.all ? "" : kind + " ";
        // An enum has values instead of members: listed with any `kind` (hiding them for kind "properties" would bring
        // back the "no members" answer), filtered by name with `member`.
        var values = doc.Values;
        if (!string.IsNullOrEmpty(memberFilter) && values is not null)
        {
            values = values.Where(v => v.Name.Contains(memberFilter, StringComparison.OrdinalIgnoreCase)).ToArray();
            output.Add("");
            output.Add(values.Length > 0
                ? $"_Showing {values.Length} {(values.Length == 1 ? "value" : "values")} whose name contains \"{memberFilter}\"._"
                : $"_No values whose name contains \"{memberFilter}\". Call get_wpf_api_reference(\"{self}\") without \"member\" to see every value._");
        }
        else if (!string.IsNullOrEmpty(memberFilter))
        {
            members = members.Where(m => m.m.Name.Contains(memberFilter, StringComparison.OrdinalIgnoreCase)).ToArray();
            var (one, many) = kind switch
            {
                MemberKind.properties => ("property", "properties"),
                MemberKind.events => ("event", "events"),
                MemberKind.methods => ("method", "methods"),
                _ => ("member", "members"),
            };
            // [Obsolete] members aren't listed, but old code and docs still use them (8 topics set HorizontalZoomable):
            // a lookup by name gets Infragistics' own note, which usually names the replacement, instead of "not found".
            var obsolete = (doc.Obsolete ?? [])
                .Where(o => IsWanted(o.Kind) && o.Name.Contains(memberFilter, StringComparison.OrdinalIgnoreCase)).ToArray();
            output.Add("");
            output.Add(members.Length > 0
                ? $"_Showing {members.Length} {(members.Length == 1 ? one : many)} whose name contains \"{memberFilter}\", including inherited ones._"
                : obsolete.Length > 0
                    ? $"_No current {many} whose name contains \"{memberFilter}\"; the matching obsolete ones:_"
                    : $"_No {many} whose name contains \"{memberFilter}\", including inherited ones. Call get_wpf_api_reference(\"{self}\") without \"member\" to see every member name, or search_wpf_api(\"{memberFilter}\") to find which type declares it._");
            foreach (var o in obsolete)
            {
                var what = o.Signature is { } signature ? $"`{signature}`" : $"`{doc.Component}.{o.Name}`";
                var from = o.DeclaredOn is { } declaredOn ? $" (inherited from `{declaredOn}`)" : "";
                output.Add($"- ⚠ OBSOLETE {o.Kind} {what}{from}: {(string.IsNullOrEmpty(o.Message) ? "don't use it." : o.Message)}");
            }
        }

        var footer = new List<string>();
        if (members.Length == 0 && string.IsNullOrEmpty(memberFilter) && values is null)
        {
            var baseHint = !string.IsNullOrEmpty(doc.BaseType)
                ? $"Call get_wpf_api_reference(\"{doc.BaseType}\") to see the inherited API surface."
                : "This type has no recorded base type in the registry — it may be a leaf/root type with no further members to inherit.";
            footer.Add("");
            footer.Add($"_No {kindPrefix}members defined directly on this type._");
            footer.Add($"_This type's own API surface is empty or was filtered by \"kind\". {baseHint}_");
        }

        // Theming hint only when the type has Brush-typed members AND ships with named themes. Not protected ones
        // (XamChart3D.CrosshairRamp): an app can't set those.
        var brushMembers = allMembers.Where(m => m.m.IsProtected != true && m.m.TypeName?.Contains("Brush", StringComparison.Ordinal) == true).Select(m => m.m).ToArray();
        if (brushMembers.Length > 0 && ThemeLookup.IsThemeable(doc.Component, store.ThemeIndex))
        {
            var examples = string.Join(", ", brushMembers.Take(3).Select(m => $"`{m.Name}`"));
            footer.Add("");
            footer.Add($"_⚠️ This type has Brush-typed properties (e.g. {examples}) and ships with named themes. Before setting these directly or writing Style/ControlTemplate overrides, call `setup_wpf_theme(component: \"{doc.Component}\")` to check whether a named theme (`Theme=\"...\"` or `ThemeManager`) already covers this, and to get exact resource file paths for customizing it._");
        }

        var withParameters = !string.IsNullOrEmpty(memberFilter);
        string Render(ApiDetail detail, string? note = null, bool protectedByName = false) => string.Join('\n',
            (note is null ? output : output.Append("").Append(note))
                .Concat(values is null ? [] : RenderValues(doc, values, compact: detail == ApiDetail.CompactAll))
                .Concat(RenderMemberSections(members, detail, protectedByName, withParameters)).Concat(footer));
        var text = Render(ApiDetail.Full);

        // Size guard: take the first level of ApiDetail whose rendering, note included, fits. Headings
        // stay, so "inherited from" remains visible; the note tells the agent how to get full details.
        // An enum (no members) only has the last level: its values by name.
        if (text.Length > MaxApiReferenceChars && values is not null)
        {
            var next = string.IsNullOrEmpty(memberFilter)
                ? $"Call get_wpf_api_reference(component: \"{self}\", member: \"<name>\") for their numbers and summaries — \"member\" is a case-insensitive substring of the value name."
                : "Call again with a more specific \"member\" for their numbers and summaries.";
            text = Render(ApiDetail.CompactAll, $"_ℹ️ Compacted: the full response would be {text.Length} characters, so values are listed by name only. {next}_");
        }
        else if (text.Length > MaxApiReferenceChars)
        {
            var fullLength = text.Length;
            var next = string.IsNullOrEmpty(memberFilter)
                ? $"Call get_wpf_api_reference(component: \"{self}\", member: \"<name>\") for full details (type, enum values, summary, every overload's signature) — \"member\" is a case-insensitive substring, so one call can cover a family of related members sharing a prefix."
                : "Call again with a more specific \"member\" for full details (type, enum values, summary, every overload's signature).";
            string Compacted((ApiDetail detail, bool protectedByName) level) =>
                Render(level.detail, $"_ℹ️ Compacted: the full response would be {fullLength} characters, so {CompactionSummary(level.detail, level.protectedByName)}. {next}_", level.protectedByName);
            // Without properties (kind: events/methods) CompactEventsMethods would only cost the members declared on this type their detail.
            var details = members.Any(m => m.kind == "property")
                ? new[] { ApiDetail.Full, ApiDetail.CompactEventsMethods, ApiDetail.CompactInherited }
                : new[] { ApiDetail.Full, ApiDetail.CompactInherited };
            bool ShowsProtectedInFull(ApiDetail detail) =>
                members.Any(m => IsProtectedMember(m.m) && !IsCompact(detail, m.kind, inherited: !string.IsNullOrEmpty(m.m.DeclaredOn)));
            // Each level as it is (Full has been tried), then with its protected properties and events by name if it shows any in full.
            var levels = details
                .SelectMany(detail => new[] { (detail, protectedByName: false), (detail, protectedByName: true) })
                .Where(level => level.protectedByName ? ShowsProtectedInFull(level.detail) : level.detail != ApiDetail.Full);
            text = levels.Select(Compacted).FirstOrDefault(t => t.Length <= MaxApiReferenceChars) ?? Compacted((ApiDetail.CompactAll, false));
        }

        log.Write("get_wpf_api_reference", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_project_scaffold ─────────────────────────────────────────────

    // \z, not $: in .NET `$` also matches before a trailing "\n", which would let "MyApp\n" through.
    [GeneratedRegex(@"^[a-zA-Z][a-zA-Z0-9._-]*\z")]
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
        [Description("""Target framework version. Defaults to "net10.0".""")]
        TargetFramework framework = TargetFramework.net10_0)
    {
        var timer = Stopwatch.StartNew();
        var input = new { components, projectName, framework = framework.Wire() };
        if (ToolInput.CheckLength("projectName", projectName, max: 128, min: 1) is { } invalid)
        {
            log.Write("get_wpf_project_scaffold", input, invalid, timer);
            return ToolResult.Error(invalid);
        }

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

        lines.Add($"## WPF Project Scaffold: `{projectName}`");
        lines.Add("");
        lines.Add("### 1. Create and configure the project");
        lines.Add("");
        lines.Add("```bash");
        lines.Add($"dotnet new wpf -n {projectName} --framework {framework.Wire()}");
        lines.Add($"cd {projectName}");
        lines.AddRange(uniquePackages.Select(pkg => $"dotnet add package {pkg}"));
        lines.Add("dotnet restore");
        lines.Add("```");
        lines.Add("");
        lines.Add("### 2. Add xmlns declarations to MainWindow.xaml");
        lines.Add("");
        lines.Add("```xml");
        lines.Add("<Window ...");
        lines.AddRange(uniqueXmlns.Select(x => $"        {x}"));
        lines.Add(">");
        lines.Add("```");

        lines.Add("");
        lines.Add("### Components resolved");
        lines.AddRange(resolved.Select(r => $"- **{r.component}** → `{r.nugetPackage}`"));

        var text = string.Join('\n', lines);
        log.Write("get_wpf_project_scaffold", input, text, timer);
        return ToolResult.Text(text);
    }
}
