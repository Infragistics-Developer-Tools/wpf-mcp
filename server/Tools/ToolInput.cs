namespace Infragistics.Wpf.Mcp.Tools;

/// Input checks the SDK doesn't do: [MinLength]/[MaxLength]/[Range] on a tool parameter only
/// describe the schema, so each tool enforces its limits itself before doing any work.
public static class ToolInput
{
    /// The error message when `value` is outside [min, max] characters, otherwise null. Pass the
    /// same numbers as the parameter's attributes. Null counts as empty, and so does whitespace
    /// for the minimum.
    public static string? CheckLength(string name, string? value, int max, int min = 0)
    {
        var length = value?.Length ?? 0;
        if (length > max) return $"`{name}` is too long ({length} characters), max {max} characters.";
        if ((value?.Trim().Length ?? 0) < min)
            return min == 1 ? $"`{name}` must not be empty." : $"`{name}` is too short, min {min} characters.";
        return null;
    }
}
