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
            Optional control name to narrow results, e.g. "XamDockManager", "XamMaskedInput", "XamDataGrid".
                  Matches topics tagged with it (case-insensitive substring), titled after it, or naming it in their text —
                  many topics are tagged with a family (xamInputs, xamSlider, xamSchedule, xamDataPresenter) rather than
                  with each control they cover. Topics tagged with or titled after the control rank first.
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
        if ((ToolInput.CheckLength("query", query, max: 128) ?? ToolInput.CheckLength("control", control, max: 64)) is { } invalid)
        {
            log.Write("search_wpf_docs", input, invalid, timer);
            return ToolResult.Error(invalid);
        }
        var tokens = SearchTools.Tokenize(query);
        var controlFilter = control?.ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(controlFilter)) controlFilter = null;
        limit = Math.Clamp(limit, 1, 50);

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
            // Hard pre-filter on control name, which also ranks: see ControlMatch.
            var (controlScore, controlMatchedOn) = controlFilter is null ? (0, "") : ControlMatch(entry, controlFilter);
            if (controlFilter is not null && controlScore == 0) continue;
            if (controlFilter is not null) controlMatchCount++;

            if (tokens.Length == 0)
            {
                results.Add((entry, controlMatchedOn, controlScore));
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
            if (controlFilter is not null) matchedOn += $"; {controlMatchedOn}";
            var score = titleHits * 4 + controlHits * 3 + tagHits * 2 + summaryHits + controlScore;
            results.Add((entry, matchedOn, score));
        }

        var ordered = results.OrderByDescending(r => r.score).ToArray();
        var totalFound = ordered.Length;
        var limited = ordered.Take(limit).ToArray();

        if (limited.Length == 0)
        {
            string msg;
            if (controlFilter is not null && controlMatchCount == 0)
                msg = $"No topic is tagged with, titled after or mentions \"{control}\". Search with `query` words alone (no `control`), or with the control this one is part of.";
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
                $"## WPF Documentation Search: {queryLabel} ({limited.Length} of {totalFound} matches)",
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

    // How strongly a topic is about a control. Tags first: a bidirectional substring match with hyphens and spaces
    // stripped, so "FinancialChart" ~ "XamFinancialChart" and "financial-chart", and "ThemeManager" ~ "IG Theme Manager";
    // a tag that is only part of the filter ("xamGrid" for "XamGridBarcode") counts least. Then the title, and the Xam*
    // names the text mentions: many topics are tagged with a family (xamInputs, xamDataPresenter) rather than with each
    // control they cover (XamMaskedInput, XamDataGrid). "MaskedInput" also finds "XamMaskedInput".
    private static (int Score, string MatchedOn) ControlMatch(DocIndexEntry entry, string filter)
    {
        var fNorm = filter.Replace("-", "").Replace(" ", "");
        var tags = entry.ControlNames.Select(c => c.ToLowerInvariant().Replace("-", "").Replace(" ", "")).ToArray();
        var tag = tags.Any(c => c.Contains(fNorm, StringComparison.Ordinal)) ? 3
            : tags.Any(c => fNorm.Contains(c, StringComparison.Ordinal)) ? 1 : 0;
        var title = entry.Title.Replace(" ", "").Contains(fNorm, StringComparison.OrdinalIgnoreCase) ? 3 : 0;
        var mentions = entry.Mentions is null ? 0
            : entry.Mentions.GetValueOrDefault(fNorm) + (fNorm.StartsWith("xam", StringComparison.Ordinal) ? 0 : entry.Mentions.GetValueOrDefault("xam" + fNorm));
        // A topic tagged with no control at all (release notes, deployment, assembly lists) names many controls in
        // passing: its mentions count once, so the family topics that cover the control rank above it.
        var score = tag + title + Math.Min(mentions, entry.ControlNames.Length > 0 ? 3 : 1);
        var how = new List<string>();
        if (tag > 0) how.Add("control tag");
        if (title > 0) how.Add("control in title");
        if (mentions > 0) how.Add($"control named {mentions}× in text");
        return (score, string.Join(", ", how));
    }

    // ── get_wpf_doc ──────────────────────────────────────────────────────────

    // Topics up to this size come back whole (2,283 of 2,307 on 26.1.21). The rest, up to 50K, come in pages split at
    // their section headings, like large theme files; they used to be cut at 6,000 characters, code samples included.
    private const int MaxDocChars = 24000;
    // Body text per page; with the response's header this stays under the 25K get_wpf_api_reference keeps to as well.
    private const int DocPageChars = 23000;

    [McpServerTool(Name = "get_wpf_doc", ReadOnly = true, Idempotent = true, OpenWorld = false)]
    [Description(ToolDescriptions.GetWpfDoc)]
    public CallToolResult GetDoc(
        [Description("""
            The exact topic slug returned by search_wpf_docs, e.g.
                  "xamdockmanager-add-content-to-a-contentpane" or "xamdockmanager-getting-started-with-xamdockmanager".
                  Case-insensitive.
            """)]
        [MinLength(1), MaxLength(160)]
        string topic,
        [Description("""
            Optional page number for topics too long for one response (the response says how many pages there are and
                  which sections each holds). Pages split at section headings and concatenate to the whole topic.
            """)]
        [Range(1, 100)]
        int? page = null)
    {
        var timer = Stopwatch.StartNew();
        var input = new { topic, page };
        if (ToolInput.CheckLength("topic", topic, max: 160, min: 1) is { } invalid)
        {
            log.Write("get_wpf_doc", input, invalid, timer);
            return ToolResult.Error(invalid);
        }

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
            $"## {(string.IsNullOrEmpty(doc.Title) ? doc.Slug : doc.Title)}",
            "",
            $"**Topic slug:** `{doc.Slug}`",
            $"**Source:** {(doc.Source == "wpf" ? "docs-wpf" : "docs-common (shared cross-platform topic)")}",
            $"**Controls:** {(doc.ControlNames.Length > 0 ? string.Join(", ", doc.ControlNames) : "_(none listed)_")}",
            $"**Tags:** {(doc.Tags.Length > 0 ? string.Join(", ", doc.Tags) : "_(none)_")}",
        };

        CallToolResult Respond(string text, bool isError = false)
        {
            log.Write("get_wpf_doc", input, text, timer);
            return isError ? ToolResult.Error(text) : ToolResult.Text(text);
        }
        // The body is the topic in Markdown, its code samples (XAML, C#, VB) in ``` fences.
        if (doc.Body.Length <= MaxDocChars)
        {
            if (page is > 1) return Respond($"page {page} is out of range: \"{doc.Slug}\" fits in one response (page: 1).", isError: true);
            return Respond(string.Join('\n', output.Concat(["", doc.Body])));
        }

        // A section longer than a page goes in line by line, so the page before it fills up instead of ending early
        // (one topic is a 600-line XAML listing under a single heading).
        var pages = XamlPages.Paginate(
            Sections(doc.Body).SelectMany(s => s.Text.Length <= DocPageChars
                ? [s] : s.Text.Split('\n').Select((line, i) => (Text: line + "\n", Label: i == 0 ? s.Label : ""))),
            DocPageChars);
        var n = page ?? 1;
        if (n > pages.Count)
            return Respond($"page {n} is out of range: \"{doc.Slug}\" has {pages.Count} pages (page: 1 to {pages.Count}).", isError: true);
        // A code block that runs across pages is closed at the end of one and reopened, language included, at the
        // start of the next, so each page is valid Markdown.
        var texts = new List<string>();
        string? openFence = null;
        foreach (var p in pages)
        {
            var reopen = openFence is null ? "" : openFence + "\n";
            foreach (var line in p.Text.Split('\n'))
                if (line.StartsWith("```", StringComparison.Ordinal)) openFence = openFence is null ? line : null;
            texts.Add(reopen + p.Text + (openFence is null ? "" : (p.Text.EndsWith('\n') ? "" : "\n") + "```\n"));
        }
        static string Headings(XamlPages.Page p) => p.Labels.Count == 0 ? "(continued)"
            : string.Join(", ", p.Labels.Take(4)) + (p.Labels.Count > 4 ? $", … ({p.Labels.Count} sections)" : "");
        output.Add("");
        output.Add($"_This topic is {doc.Body.Length} characters, so it comes in {pages.Count} pages split at its section headings; " +
                   $"this is page {n}. {(n < pages.Count ? $"Next: page: {n + 1}." : "This is the last page.")} Contents:_");
        output.AddRange(pages.Select((p, i) => $"- Page {i + 1}: {Headings(p)}"));
        output.Add("");
        output.Add(texts[n - 1]);
        return Respond(string.Join('\n', output));
    }

    // The body split before each heading line ("## Binding to Data"), labelled with the heading. A # line inside a code
    // fence (a C# #region) is code, not a heading.
    private static IEnumerable<(string Text, string Label)> Sections(string body)
    {
        var start = 0;
        var label = "";
        var inFence = false;
        var lineStart = 0;
        while (lineStart < body.Length)
        {
            var lineEnd = body.IndexOf('\n', lineStart);
            var next = lineEnd < 0 ? body.Length : lineEnd + 1;
            var line = body[lineStart..(lineEnd < 0 ? body.Length : lineEnd)];
            if (line.StartsWith("```", StringComparison.Ordinal)) inFence = !inFence;
            else if (!inFence && line.StartsWith('#') && line.TrimStart('#').StartsWith(' ') && lineStart > start)
            {
                yield return (body[start..lineStart], label);
                start = lineStart;
            }
            if (!inFence && lineStart == start && line.StartsWith('#')) label = line.TrimStart('#').Trim();
            lineStart = next;
        }
        yield return (body[start..], label);
    }
}
