using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Diagnostics;
using Infragistics.Wpf.Mcp.Data;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Infragistics.Wpf.Mcp.Tools;

[McpServerToolType]
public sealed class DocsTools(DataStore store, ToolLog log)
{
    // ── search_wpf_docs ──────────────────────────────────────────────────────

    [McpServerTool(Name = "search_wpf_docs", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.SearchWpfDocs)]
    public CallToolResult SearchDocs(
        [Description("""
            Keyword or phrase to search across documentation titles, tags, control names, and summaries.
                  Case-insensitive. Words use OR/ranked matching — topics matching MORE words rank higher, but a topic matching
                  only one word can still be returned, so prefer 2-4 distinct/specific words over a full sentence.
                  Examples: "restrict floating", "getting started", "column series", "grouping summary".
                  Omit entirely (with `control` set) to browse ALL topics for a component.
            """)]
        [MaxLength(128)]
        string? query = null,
        [Description("""
            Optional control name to narrow results, e.g. "XamDockManager", "ContentPane", "XamDataGrid".
                  Case-insensitive substring match against the topic's associated control names.
                  At least one of `query` or `control` must be provided.
            """)]
        [MaxLength(64)]
        string? control = null,
        [Description("""Maximum number of results to return. Defaults to 10, max 50.""")]
        [Range(1, 50)]
        int limit = 10)
    {
        var timer = Stopwatch.StartNew();
        var input = new { query, control, limit };
        var tokens = SearchTools.Tokenize(query);
        var controlFilter = control?.ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(controlFilter)) controlFilter = null;
        limit = Math.Min(limit, 50);

        if (tokens.Length == 0 && controlFilter is null)
        {
            var msg = "Provide at least one of `query` or `control`. Pass `control` alone to browse every topic for a component, or add `query` keywords to narrow further.";
            log.Write("search_wpf_docs", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var controlMatchCount = 0;
        var results = new List<(DocIndexEntry entry, string matchedOn, int score)>();

        foreach (var entry in store.DocIndex)
        {
            // Hard pre-filter on control name: bidirectional substring match with hyphens
            // stripped, so "FinancialChart" ~ "XamFinancialChart" and "financial-chart" both hit.
            if (controlFilter is not null && !entry.ControlNames.Any(c =>
                {
                    var cNorm = c.ToLowerInvariant().Replace("-", "");
                    var fNorm = controlFilter.Replace("-", "");
                    return cNorm.Contains(fNorm, StringComparison.Ordinal) || fNorm.Contains(cNorm, StringComparison.Ordinal);
                }))
            {
                continue;
            }
            if (controlFilter is not null) controlMatchCount++;

            if (tokens.Length == 0)
            {
                results.Add((entry, "control name", 0));
                continue;
            }

            var titleLower = entry.Title.ToLowerInvariant();
            var controlsLower = string.Join(' ', entry.ControlNames).ToLowerInvariant();
            var tagsLower = string.Join(' ', entry.Tags).ToLowerInvariant();
            var summaryLower = entry.Summary.ToLowerInvariant();

            var titleHits = tokens.Count(t => titleLower.Contains(t, StringComparison.Ordinal));
            var controlHits = tokens.Count(t => controlsLower.Contains(t, StringComparison.Ordinal));
            var tagHits = tokens.Count(t => tagsLower.Contains(t, StringComparison.Ordinal));
            var summaryHits = tokens.Count(t => summaryLower.Contains(t, StringComparison.Ordinal));
            if (titleHits + controlHits + tagHits + summaryHits == 0) continue;

            var matchedOn = titleHits > 0 ? "title" : controlHits > 0 ? "control name" : tagHits > 0 ? "tags" : "summary";
            var score = titleHits * 4 + controlHits * 3 + tagHits * 2 + summaryHits;
            results.Add((entry, matchedOn, score));
        }

        var ordered = results.OrderByDescending(r => r.score).ToArray();
        var totalFound = ordered.Length;
        var limited = ordered.Take(limit).ToArray();

        if (limited.Length == 0)
        {
            string msg;
            if (controlFilter is not null && controlMatchCount == 0)
                msg = $"No indexed topics reference control \"{control}\". Check the exact name with list_wpf_components — the control filter is a substring match, so a typo or wrong casing of the underlying name returns nothing.";
            else if (controlFilter is not null)
                msg = $"{controlMatchCount} topic(s) reference control \"{control}\", but none matched any word in \"{query}\". Try fewer/simpler keywords, or call search_wpf_docs(control: \"{control}\") with no query to browse all {controlMatchCount} topics for this component.";
            else
                msg = $"No documentation topics found matching any word in \"{query}\". Try shorter or more general keywords (e.g. \"getting started\", \"grouping\", \"pin pane\"), or add `control` to browse a specific component's topics directly.";
            log.Write("search_wpf_docs", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var lines = limited.Select(r => string.Join('\n', new[]
        {
            $"### {(string.IsNullOrEmpty(r.entry.Title) ? r.entry.Slug : r.entry.Title)}",
            $"- **Topic slug:** `{r.entry.Slug}`",
            $"- **Matched on:** {r.matchedOn}",
            $"- **Controls:** {(r.entry.ControlNames.Length > 0 ? string.Join(", ", r.entry.ControlNames) : "_(none listed)_")}",
            $"- **Tags:** {(r.entry.Tags.Length > 0 ? string.Join(", ", r.entry.Tags) : "_(none)_")}",
            $"- {(string.IsNullOrEmpty(r.entry.Summary) ? "_(no summary)_" : r.entry.Summary)}",
        }));

        var queryLabel = !string.IsNullOrEmpty(query) ? $"\"{query}\"" : "(browsing by control)";
        var text = string.Join("\n\n", new[]
            {
                $"# WPF Documentation Search: {queryLabel} ({limited.Length} of {totalFound} matches)",
                "",
            }
            .Concat(lines)
            .Concat(new[]
            {
                "",
                "_Call `get_wpf_doc` with any topic slug above to retrieve the full text and XAML code samples._",
            }));

        log.Write("search_wpf_docs", input, text, timer);
        return ToolResult.Text(text);
    }

    // ── get_wpf_doc ──────────────────────────────────────────────────────────

    private const int MaxBodyChars = 6000;
    private const int MaxSnippetsShown = 6;
    private const int MaxSnippetChars = 3000;

    [McpServerTool(Name = "get_wpf_doc", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfDoc)]
    public CallToolResult GetDoc(
        [Description("""
            The exact topic slug returned by search_wpf_docs, e.g.
                  "xamdockmanager-add-content-to-a-contentpane" or "xamdockmanager-getting-started-with-xamdockmanager".
                  Case-insensitive.
            """)]
        [MinLength(1), MaxLength(160)]
        string topic)
    {
        var timer = Stopwatch.StartNew();
        var input = new { topic };

        var doc = store.LoadDoc(topic);
        if (doc is null)
        {
            var topicLower = topic.ToLowerInvariant();
            var suggestions = store.DocIndex
                .Where(e => e.Slug.ToLowerInvariant().Contains(topicLower, StringComparison.Ordinal)
                         || e.Title.ToLowerInvariant().Contains(topicLower, StringComparison.Ordinal))
                .Take(5)
                .Select(e => $"`{e.Slug}`")
                .ToArray();
            var hint = suggestions.Length > 0
                ? $" Did you mean: {string.Join(", ", suggestions)}?"
                : " Call `search_wpf_docs` with a keyword to find the correct topic slug.";
            var msg = $"Documentation topic \"{topic}\" not found.{hint}";
            log.Write("get_wpf_doc", input, msg, timer);
            return ToolResult.Error(msg);
        }

        var output = new List<string>
        {
            $"# {(string.IsNullOrEmpty(doc.Title) ? doc.Slug : doc.Title)}",
            "",
            $"**Topic slug:** `{doc.Slug}`",
            $"**Source:** {(doc.Source == "wpf" ? "docs-wpf" : "docs-common (shared cross-platform topic)")}",
            $"**Controls:** {(doc.ControlNames.Length > 0 ? string.Join(", ", doc.ControlNames) : "_(none listed)_")}",
            $"**Tags:** {(doc.Tags.Length > 0 ? string.Join(", ", doc.Tags) : "_(none)_")}",
        };

        if (doc.XamlSnippets.Length > 0)
        {
            output.Add("");
            output.Add("## XAML Examples");
            var shown = doc.XamlSnippets.Take(MaxSnippetsShown).ToArray();
            for (var i = 0; i < shown.Length; i++)
            {
                var snippet = shown[i];
                var text = snippet.Length > MaxSnippetChars
                    ? $"{snippet[..MaxSnippetChars]}\n<!-- truncated, {snippet.Length} chars total -->"
                    : snippet;
                output.Add("");
                output.Add($"### Example {i + 1}");
                output.Add("```xml");
                output.Add(text);
                output.Add("```");
            }
            var remaining = doc.XamlSnippets.Length - shown.Length;
            if (remaining > 0)
            {
                output.Add("");
                output.Add($"_{remaining} additional XAML example(s) omitted for brevity._");
            }
        }
        else
        {
            output.Add("");
            output.Add("_This topic has no extracted XAML code samples — see body text below for conceptual guidance._");
        }

        var body = doc.Body.Length > MaxBodyChars
            ? $"{doc.Body[..MaxBodyChars]}\n\n_(truncated, {doc.Body.Length} chars total)_"
            : doc.Body;
        output.Add("");
        output.Add("## Full Topic Text");
        output.Add("");
        output.Add(body);

        var result = string.Join('\n', output);
        log.Write("get_wpf_doc", input, result, timer);
        return ToolResult.Text(result);
    }
}
