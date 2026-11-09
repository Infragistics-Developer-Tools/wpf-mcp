using System.Text.Json.Serialization;

namespace Infragistics.Wpf.Mcp.Data;

// C# consumer of the shapes produced by scripts/*.ts (src/lib/types.ts is the frozen TS consumer).
// Change this together with the producer; see "Conventions" in CLAUDE.md for when src/ needs it too.

public sealed record ComponentEntry(
    string Component,
    string XamlNamespace,
    string DefaultPrefix,
    string DotnetNamespace,
    string NugetPackage,
    string Assembly,
    string Description,
    AlternateType[]? Alternates = null);   // other types of this name (the newer XamComboEditor), opened by full name

public sealed record ApiMemberEntry(
    string Name,
    string Summary,
    string? TypeName,
    bool? IsNullable,
    bool? IsEnum,
    string[]? EnumValues,
    string? DeclaredOn,
    bool? IsField = null,          // a static ResourceKey/RoutedCommand field, listed with the properties
    string? Signature = null,      // methods, constructors and indexers: "void Export(OutputFormat outputFormat, string fileName)"
    ParamDoc[]? Parameters = null,
    bool? IsProtected = null);     // a protected property or event (methods say so in their signature)

public sealed record ParamDoc(string Name, string Summary);

/// One value of an enum, in declaration order.
public sealed record EnumValue(
    string Name,
    long Value,
    string Summary,
    string? Obsolete = null);      // the [Obsolete] message, usually naming the replacement

/// A member marked [Obsolete]: left out of the member lists, kept so a lookup by name gets the replacement.
public sealed record ObsoleteMember(
    string Name,
    string Kind,                   // "property", "event", "method" or "constructor"
    string Message,                // Infragistics' own, usually naming the replacement
    string? Signature = null,
    string? DeclaredOn = null);

/// Another type with the page's short name, or (SameType) the same class listed under another package.
public sealed record AlternateType(
    string FullName,
    string NugetPackage,
    int MemberCount,                         // properties + events + methods, inherited ones included
    string? Assembly = null,
    bool? SameType = null,                   // same assembly and full name as the page's type: no page of its own
    string? Lookup = null,                   // what get_wpf_api_reference takes to open it: the full name (+ ", Assembly")
    bool? IsDefault = null,                  // the type the short name opens
    string? XamlNamespace = null,
    string? DefaultPrefix = null,
    string? Summary = null,                  // its summary's first sentence
    int? ValueCount = null,                  // enums: how many values,
    string[]? ValueNames = null);            // and the first few

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
    ApiMemberEntry[] Methods,
    string? XamlName = null,    // nested types only: "Outer+Inner"
    ApiMemberEntry[]? Constructors = null,   // public ones that take parameters
    ObsoleteMember[]? Obsolete = null,
    string? ObsoleteMessage = null,          // the type itself is [Obsolete]
    EnumValue[]? Values = null,              // enums only
    bool? IsFlags = null,                    // a [Flags] enum
    string? Lookup = null);                  // a type that lost its short name (api/alternates/): what opens this page

/// Compact entry in search-index.json — single-letter keys keep the ~5MB index small.
public sealed record SearchIndexEntry(
    [property: JsonPropertyName("n")] string TypeName,
    [property: JsonPropertyName("s")] string Summary,
    [property: JsonPropertyName("a")] string Assembly,
    [property: JsonPropertyName("p")] string NugetPackage,
    [property: JsonPropertyName("m")] string[] Members,
    [property: JsonPropertyName("f")] string? Lookup = null);   // types of a shared name: the full name that opens this one

public record DocIndexEntry(
    string Slug,
    string Title,
    string[] ControlNames,
    string[] Tags,
    string Source,
    string Summary,
    Dictionary<string, int>? Mentions = null);   // Xam* names the topic mentions, lowercased → count

public sealed record DocEntry(
    string Slug,
    string Title,
    string[] ControlNames,
    string[] Tags,
    string Source,
    string Summary,
    string Body,                 // Markdown: # headings, code in ``` fences
    string[] XamlSnippets,
    Dictionary<string, int>? Mentions = null) : DocIndexEntry(Slug, Title, ControlNames, Tags, Source, Summary, Mentions);

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
