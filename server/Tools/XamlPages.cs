using System.Text;
using System.Xml;

namespace Infragistics.Wpf.Mcp.Tools;

/// Splits a XAML resource dictionary into pages at its top-level elements, so a theme file of any size can be read
/// completely: the pages concatenate back to the exact file. On the 26.1.21 data, 436 of 822 theme files are over
/// the 24,000-character cut-off get_wpf_theme_resource used to apply, up to 659K (RibbonGeneric.xaml, 33 pages).
internal static class XamlPages
{
    /// One top-level element with the comments and indentation that lead into it.
    internal sealed record Entry(string Text, string Label, string Search);

    /// Head: prolog and root start tag. Tail: root end tag and anything after it.
    internal sealed record Parts(string Head, IReadOnlyList<Entry> Entries, string Tail);

    internal sealed record Page(string Text, IReadOnlyList<string> Labels);

    /// The file split into top-level elements, or null if it isn't well-formed XML or has no child elements.
    public static Parts? Parse(string text)
    {
        var lineStarts = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++)
            if (text[i] == '\n') lineStarts.Add(i + 1);
        int Offset(int line, int position) => lineStarts[line - 1] + position - 1;

        var starts = new List<(int At, string Label, string Search)>();
        int? leadingComment = null;
        var rootEnd = -1;
        try
        {
            // Namespaces = false: a few Infragistics files use a prefix they never declare (DataPresenterHulk.xaml).
            using var reader = new XmlTextReader(new StringReader(text))
            {
                Namespaces = false, DtdProcessing = DtdProcessing.Ignore, WhitespaceHandling = WhitespaceHandling.All,
            };
            var positioned = false;   // Skip() already moved to the next node
            while (positioned || reader.Read())
            {
                positioned = false;
                if (reader.Depth == 1 && reader.NodeType == XmlNodeType.Comment)
                {
                    leadingComment ??= text.LastIndexOf("<!--", Offset(reader.LineNumber, reader.LinePosition), StringComparison.Ordinal);
                }
                else if (reader.Depth == 1 && reader.NodeType == XmlNodeType.Element)
                {
                    var at = Offset(reader.LineNumber, reader.LinePosition) - 1;   // LinePosition points at the name, after '<'
                    if (at < 0 || text[at] != '<') return null;
                    at = leadingComment ?? at;
                    leadingComment = null;
                    var lineStart = text.LastIndexOf('\n', Math.Max(0, at - 1)) + 1;
                    if (at > 0 && string.IsNullOrWhiteSpace(text[lineStart..at])) at = lineStart;   // keep the indentation

                    var key = reader.GetAttribute("x:Key");
                    var target = TypeName(reader.GetAttribute("TargetType") ?? reader.GetAttribute("DataType"));
                    starts.Add((at, key ?? target ?? reader.Name, $"{reader.Name} {key} {target}"));
                    reader.Skip();
                    positioned = true;
                }
                else if (reader.Depth == 0 && reader.NodeType == XmlNodeType.EndElement)
                {
                    rootEnd = Offset(reader.LineNumber, reader.LinePosition) - 2;   // points at the name, after "</"
                }
            }
        }
        catch (XmlException) { return null; }

        if (starts.Count == 0 || rootEnd < 0) return null;
        // The tail starts at the root end tag's line, unless something else shares that line ("</Style></ResourceDictionary>").
        var tailStart = text.LastIndexOf('\n', rootEnd - 1) + 1;
        if (tailStart <= starts[^1].At || !string.IsNullOrWhiteSpace(text[tailStart..rootEnd])) tailStart = rootEnd;
        var entries = starts.Select((s, i) => new Entry(
            text[s.At..(i + 1 < starts.Count ? starts[i + 1].At : tailStart)], s.Label, s.Search)).ToList();
        return new Parts(text[..starts[0].At], entries, text[tailStart..]);
    }

    /// Pages of at most `budget` characters: whole entries while they fit; an entry bigger than a page continues on
    /// the next at a line break (a line longer than a page, which no theme file has, is cut at the budget).
    public static List<Page> Paginate(IEnumerable<(string Text, string Label)> pieces, int budget)
    {
        var pages = new List<Page>();
        var current = new StringBuilder();
        var labels = new List<string>();
        void Flush()
        {
            if (current.Length == 0) return;
            pages.Add(new Page(current.ToString(), labels));
            current.Clear();
            labels = new List<string>();
        }

        foreach (var (text, label) in pieces)
        {
            if (current.Length + text.Length > budget) Flush();
            if (text.Length <= budget)
            {
                current.Append(text);
                if (label.Length > 0) labels.Add(label);
                continue;
            }
            var first = true;
            foreach (var line in Lines(text, budget))
            {
                if (current.Length + line.Length > budget) Flush();
                current.Append(line);
                if (first && label.Length > 0) labels.Add($"{label} (continues)");
                first = false;
            }
        }
        Flush();
        return pages;
    }

    private static IEnumerable<string> Lines(string text, int budget)
    {
        var start = 0;
        for (var i = 0; i <= text.Length; i++)
        {
            if (i < text.Length && text[i] != '\n' && i - start + 1 < budget) continue;
            var end = Math.Min(i + 1, text.Length);
            if (end > start) yield return text[start..end];
            start = end;
        }
    }

    /// "{x:Type CheckBox}" → "CheckBox"; anything else unchanged.
    private static string? TypeName(string? value) =>
        value is not null && value.StartsWith("{x:Type ", StringComparison.Ordinal) && value.EndsWith('}')
            ? value[8..^1].Trim()
            : value;
}
