using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Infragistics.Wpf.Mcp.Data;

/// Loads the generated data set from `data/` next to the executable — the same files
/// `dist/data/` holds for the npm package. Indexes are read once; api docs, doc topics
/// and theme XAML are read on demand (mirrors src/lib/*-loader.ts).
public sealed class DataStore
{
    private readonly string _apiDir;
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
