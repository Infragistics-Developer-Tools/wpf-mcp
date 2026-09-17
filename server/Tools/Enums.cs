using System.Text.Json.Serialization;

namespace Infragistics.Wpf.Mcp.Tools;

// Enum inputs mirror the z.enum() lists in src/tools/schemas.ts; member names are the
// wire values (they double as the schema `enum` list).

[JsonConverter(typeof(JsonStringEnumConverter<MemberKind>))]
public enum MemberKind { all, properties, methods, events }

[JsonConverter(typeof(JsonStringEnumConverter<TargetFramework>))]
public enum TargetFramework
{
    [JsonStringEnumMemberName("netcoreapp3.0")] netcoreapp3_0,
    [JsonStringEnumMemberName("netcoreapp3.1")] netcoreapp3_1,
    [JsonStringEnumMemberName("net5.0")] net5_0,
    [JsonStringEnumMemberName("net6.0")] net6_0,
    [JsonStringEnumMemberName("net7.0")] net7_0,
    [JsonStringEnumMemberName("net8.0")] net8_0,
    [JsonStringEnumMemberName("net9.0")] net9_0,
    [JsonStringEnumMemberName("net10.0")] net10_0,
}

public static class EnumText
{
    public static string Wire(this TargetFramework f) => f.ToString().Replace('_', '.');
}
