using System.Diagnostics;
using System.Text.Json;

namespace Infragistics.Wpf.Mcp.Tools;

/// `--debug` call log, same format and default location as the npm server
/// ($TMP/wpf-mcp.log, override with WPF_MCP_LOG). Never throws into a tool call.
public sealed class ToolLog
{
    private readonly bool _enabled;
    public string Path { get; }

    public ToolLog(bool enabled)
    {
        _enabled = enabled;
        Path = Environment.GetEnvironmentVariable("WPF_MCP_LOG")
            ?? System.IO.Path.Combine(System.IO.Path.GetTempPath(), "wpf-mcp.log");
        if (enabled) Console.Error.WriteLine($"[wpf-mcp] debug log: {Path}");
    }

    public void Write(string tool, object input, string output, Stopwatch timer)
    {
        if (!_enabled) return;
        var preview = output.Length > 400 ? $"{output[..400]}… ({output.Length} chars)" : output;
        try
        {
            File.AppendAllText(Path,
                $"[{DateTime.UtcNow:yyyy-MM-dd'T'HH:mm:ss.fff'Z'}] {tool} ({timer.ElapsedMilliseconds}ms)\n  IN:  {JsonSerializer.Serialize(input)}\n  OUT: {preview}\n\n");
        }
        catch
        {
        }
    }
}
