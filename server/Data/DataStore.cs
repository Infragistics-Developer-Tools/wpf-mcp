using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Infragistics.Wpf.Mcp.Data;

/// Loads the generated data set from `data/` next to the executable — the same files
/// `dist/data/` holds for the npm package. Indexes are read once; api docs, doc topics
/// and theme XAML are read on demand (originally ported from src/lib/*-loader.ts).
public sealed class DataStore
{
    private readonly string _apiDir;
    private readonly string _altDir;
    private readonly string _docsDir;
    private readonly string _themeDir;

    public ComponentEntry[] Components { get; }
    public SearchIndexEntry[] SearchIndex { get; }
    public DocIndexEntry[] DocIndex { get; }
    public ThemeIndex ThemeIndex { get; }
    public BuildInfo? BuildInfo { get; }

    public DataStore(string root)
    {
        root = Path.GetFullPath(root);
        _apiDir = Path.Combine(root, "api");
        _altDir = Path.Combine(_apiDir, "alternates");
        _docsDir = Path.Combine(root, "docs");
        _themeDir = Path.Combine(root, "theme-resources");

        Components = Read(Path.Combine(root, "namespaces.json"), WpfJsonContext.Default.ComponentEntryArray)
            ?? throw new FileNotFoundException("namespaces.json not found — run `npm run build:data` first.", root);
        SearchIndex = Read(Path.Combine(root, "search-index.json"), WpfJsonContext.Default.SearchIndexEntryArray)
            ?? throw new FileNotFoundException("search-index.json not found — run `npm run build:data` first.", root);
        DocIndex = Read(Path.Combine(root, "docs-index.json"), WpfJsonContext.Default.DocIndexEntryArray) ?? [];
        ThemeIndex = Read(Path.Combine(root, "theme-index.json"), WpfJsonContext.Default.ThemeIndex) ?? ThemeIndex.Empty;
        BuildInfo = Read(Path.Combine(root, "build-info.json"), WpfJsonContext.Default.BuildInfo);
    }

    public ApiEntry? LoadApiDoc(string component) =>
        LoadByName(_apiDir, component, WpfJsonContext.Default.ApiEntry);

    /// A type by short name ("XamComboEditor": the page that name opens, as LoadApiDoc) or by full name
    /// ("Infragistics.Controls.Editors.XamComboEditor"; nested types "Ns.Outer.Inner" or "Ns.Outer+Inner"; plus
    /// ", Assembly" for a full name two assemblies have). A full name also opens the types that lost their short name
    /// to another (api/alternates/), found through the short name's page, which lists them. When there is no such
    /// type, `byShortName` is that page, if any, for the not-found message.
    public ApiEntry? LoadApiType(string name, out ApiEntry? byShortName)
    {
        byShortName = null;
        // A short name, looked up exactly as before (no type's short name has a dot or a "+").
        if (!name.Contains('.') && !name.Contains('+')) return LoadApiDoc(name);

        // "Ns.Type, Assembly" — and a whole assembly-qualified name: ", Version=…" and the rest are ignored.
        var parts = name.Split(',');
        var fullName = parts[0].Trim().Replace('+', '.');
        var assembly = parts.Length > 1 ? parts[1].Trim() : null;
        var shortName = fullName[(fullName.LastIndexOf('.') + 1)..];
        if (shortName.Length == 0 || LoadApiDoc(shortName) is not { } page) return null;
        byShortName = page;

        // The page's own type first (a full name two assemblies share opens it), then the others; exact case first.
        foreach (var comparison in new[] { StringComparison.Ordinal, StringComparison.OrdinalIgnoreCase })
        {
            bool Matches(string typeFullName, string? typeAssembly) =>
                string.Equals(typeFullName, fullName, comparison) && (assembly is null || string.Equals(typeAssembly, assembly, comparison));
            if (Matches($"{page.DotnetNamespace}.{page.Component}", page.Assembly)) return page;
            if (page.Alternates?.FirstOrDefault(a => a.Lookup is not null && Matches(a.FullName, a.Assembly)) is { } other)
                return LoadByName(_altDir, other.Lookup!, WpfJsonContext.Default.ApiEntry);
        }
        return null;
    }

    public DocEntry? LoadDoc(string slug) =>
        LoadByName(_docsDir, slug, WpfJsonContext.Default.DocEntry);

    /// Reads a theme XAML file by its theme-index-relative path. Null if missing, a
    /// directory, or outside the resources directory.
    public string? LoadThemeResource(string relPath)
    {
        var full = ResolveInside(_themeDir, relPath);
        if (full is null || !File.Exists(full)) return null;
        return File.ReadAllText(full);
    }

    // Exact `{name}.json` first, then a case-insensitive directory scan.
    private static T? LoadByName<T>(string dir, string name, JsonTypeInfo<T> typeInfo) where T : class
    {
        if (!Directory.Exists(dir)) return null;

        var exact = ResolveInside(dir, $"{name}.json");
        if (exact is null) return null;
        if (File.Exists(exact)) return Read(exact, typeInfo);

        var wanted = $"{name.ToLowerInvariant()}.json";
        var match = Directory.EnumerateFiles(dir)
            .FirstOrDefault(f => Path.GetFileName(f).ToLowerInvariant() == wanted);
        return match is null ? null : Read(match, typeInfo);
    }

    /// Join `name` onto `dir`, null if the result escapes `dir`. Containment rather than a
    /// character allowlist because generated names contain backticks, spaces and braces.
    private static string? ResolveInside(string dir, string name)
    {
        string full;
        try
        {
            full = Path.GetFullPath(Path.Combine(dir, name));
        }
        catch (Exception e) when (e is ArgumentException or PathTooLongException or NotSupportedException)
        {
            return null;
        }
        return full == dir || full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.Ordinal) ? full : null;
    }

    private static T? Read<T>(string path, JsonTypeInfo<T> typeInfo) where T : class
    {
        if (!File.Exists(path)) return null;
        using var stream = File.OpenRead(path);
        return JsonSerializer.Deserialize(stream, typeInfo);
    }
}
