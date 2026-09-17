using System.Text.Json.Serialization;

namespace Infragistics.Wpf.Mcp.Data;

// Mirrors src/lib/types.ts — change both when changing the data shape.

public sealed record ComponentEntry(
    string Component,
    string XamlNamespace,
    string DefaultPrefix,
    string DotnetNamespace,
    string NugetPackage,
    string Assembly,
    string Description);

public sealed record ApiMemberEntry(
    string Name,
    string Summary,
    string? TypeName,
    bool? IsNullable,
    bool? IsEnum,
    string[]? EnumValues,
    string? DeclaredOn);

public sealed record AlternateType(string FullName, string NugetPackage, int MemberCount);

public sealed record ApiEntry(
    string Component,
    string Assembly,
    string NugetPackage,
    string XamlNamespace,
    string DefaultPrefix,
    string DotnetNamespace,
    string Summary,
    string Remarks,
    string? BaseType,
    AlternateType[]? Alternates,
    ApiMemberEntry[] Properties,
    ApiMemberEntry[] Events,
    ApiMemberEntry[] Methods);

/// Compact entry in search-index.json — single-letter keys keep the ~5MB index small.
public sealed record SearchIndexEntry(
    [property: JsonPropertyName("n")] string TypeName,
    [property: JsonPropertyName("s")] string Summary,
    [property: JsonPropertyName("a")] string Assembly,
    [property: JsonPropertyName("p")] string NugetPackage,
    [property: JsonPropertyName("m")] string[] Members);

public record DocIndexEntry(
    string Slug,
    string Title,
    string[] ControlNames,
    string[] Tags,
    string Source,
    string Summary);

public sealed record DocEntry(
    string Slug,
    string Title,
    string[] ControlNames,
    string[] Tags,
    string Source,
    string Summary,
    string Body,
    string[] XamlSnippets) : DocIndexEntry(Slug, Title, ControlNames, Tags, Source, Summary);

public sealed record ThemeResourceFile(string Path, string File, string[] TargetTypes);

public sealed record NewerThemeEntry(string Theme, ThemeResourceFile[] Files);

public sealed record LegacyStyleEntry(string Folder, ThemeResourceFile[] Files);

public sealed record ThemeIndex(NewerThemeEntry[] NewerThemes, LegacyStyleEntry[] LegacyStyles)
{
    public static readonly ThemeIndex Empty = new([], []);
}

public sealed record BuildInfo(string InfragisticsVersion, string BuiltAt);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ComponentEntry[]))]
[JsonSerializable(typeof(ApiEntry))]
[JsonSerializable(typeof(SearchIndexEntry[]))]
[JsonSerializable(typeof(DocIndexEntry[]))]
[JsonSerializable(typeof(DocEntry))]
[JsonSerializable(typeof(ThemeIndex))]
[JsonSerializable(typeof(BuildInfo))]
public sealed partial class WpfJsonContext : JsonSerializerContext;
