using ModelContextProtocol.Protocol;

namespace Infragistics.Wpf.Mcp.Tools;

public static class ToolResult
{
    public static CallToolResult Text(string text) =>
        new() { Content = [new TextContentBlock { Text = text }] };

    public static CallToolResult Error(string text) =>
        new() { Content = [new TextContentBlock { Text = text }], IsError = true };
}
