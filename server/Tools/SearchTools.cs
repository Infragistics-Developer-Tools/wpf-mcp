using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using System.Text.RegularExpressions;
using Infragistics.Wpf.Mcp.Data;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Infragistics.Wpf.Mcp.Tools;

[McpServerToolType]
public sealed partial class SearchTools(DataStore store, ToolLog log)
{
    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    /// `query.toLowerCase().trim().split(/\s+/).filter(Boolean)`
    internal static string[] Tokenize(string? query) =>
        Whitespace().Split((query ?? "").ToLowerInvariant().Trim()).Where(t => t.Length > 0).ToArray();

    // ── search_wpf_api ───────────────────────────────────────────────────────

    [McpServerTool(Name = "search_wpf_api", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.SearchWpfApi)]
    public CallToolResult SearchApi(
        [Description("""
            Keyword or phrase to search across type names, summaries, and member names.
                  Case-insensitive. Multiple words use OR/ranked logic — a type matching MORE words ranks
                  higher, but a type matching only one word can still be returned, so prefer 2-4
                  distinct/specific words over a full sentence.
                  Examples: "filter", "DataSource", "FieldSettings AllowEdit", "XamDataGrid sort".
            """)]
        [MinLength(1), MaxLength(128)]
        string query,
        [Description("""Maximum number of results to return. Defaults to 10, max 50.""")]
        [Range(1, 50)]
        int limit = 10)
    {
        var timer = Stopwatch.StartNew();
        var input = new { query, limit };
        if (ToolInput.CheckLength("query", query, max: 128, min: 1) is { } invalid)
        {
            log.Write("search_wpf_api", input, invalid, timer);
            return ToolResult.Error(invalid);
        }
        var tokens = Tokenize(query);
        limit = Math.Clamp(limit, 1, 50);

        var results = new List<(string typeName, string summary, string nugetPackage, string? lookup, string matchedOn, int score)>();

        foreach (var entry in store.SearchIndex)
        {
            var typeLower = entry.TypeName.ToLowerInvariant();
            var summaryLower = entry.Summary.ToLowerInvariant();
            var membersLower = entry.Members.Select(m => m.ToLowerInvariant()).ToArray();

            // Ranked/OR matching: more token hits rank higher, one hit is still a result.
            var nameHits = tokens.Count(t => typeLower.Contains(t, StringComparison.Ordinal));
            var summaryHits = tokens.Count(t => summaryLower.Contains(t, StringComparison.Ordinal));
            var memberHits = tokens.Count(t => membersLower.Any(m => m.Contains(t, StringComparison.Ordinal)));
            if (nameHits + summaryHits + memberHits == 0) continue;

            var matchedOn = nameHits > 0
                ? "name"
                : memberHits > 0
                    ? "members: " + string.Join(", ", tokens
                        .SelectMany(t => entry.Members.Where(m => m.ToLowerInvariant().Contains(t, StringComparison.Ordinal)))
                        .Distinct())
                    : "summary";

            var score = nameHits * 4 + memberHits * 2 + summaryHits;
            results.Add((entry.TypeName, entry.Summary, entry.NugetPackage, entry.Lookup, matchedOn, score));
        }

        // Ties: the types of a shared name that the query spells exactly ("Axis": the chart's, Excel's) come first. They
        // came after the others of their score, the ones that lost the name last of all, and the limit cut them off.
        // OrderBy is stable, so every other result keeps its order.
        var ordered = results.OrderByDescending(r => r.score)
            .ThenByDescending(r => r.lookup is not null && string.Equals(r.typeName, query.Trim(), StringComparison.OrdinalIgnoreCase))
            .ToArray();
        var totalFound = ordered.Length;
        var limited = ordered.Take(limit).ToArray();

        if (limited.Length == 0)
        {
            var hint = tokens.Length > 1
                ? "It looks like you may be trying to verify specific members on a known type. Use get_wpf_api_reference(\"TypeName\") instead — it returns the complete property, method, and event list so you can inspect it directly. Reserve search_wpf_api for discovery when you don't know the type name yet."
                : "Try a different keyword or call list_wpf_components to browse available controls.";
            var msg = $"No API entries found matching any word in \"{query}\". {hint}";
            log.Write("search_wpf_api", input, msg, timer);
            return ToolResult.Error(msg);
        }

        // A type whose name others share (the two XamComboEditors) says which full name opens it: the name alone opens one of them.
        var lines = limited.Select(r =>
            $"### {r.typeName}\n- **Matched:** {r.matchedOn}\n- **NuGet:** `{r.nugetPackage}`\n" +
            (r.lookup is { } lookup ? $"- **Several types are named \"{r.typeName}\":** open this one with get_wpf_api_reference(\"{lookup}\")\n" : "") +
            $"- {(string.IsNullOrEmpty(r.summary) ? "_(no summary)_" : r.summary)}");

        var text = string.Join("\n\n", new[]
            {
                $"## WPF API Search: \"{query}\" ({limited.Length} of {totalFound} matches)",
                "",
            }
            .Concat(lines)
            .Concat(new[]
            {
                "",
                "_Call `get_wpf_api_reference` with any type name above for full member details._",
            }));

        log.Write("search_wpf_api", input, text, timer);
        return ToolResult.Text(text);
    }
}
