using System.Diagnostics;
using System.Text.Json;

namespace Infragistics.Wpf.Mcp.Tools;

/// `--debug` call log, same format and default location as the npm server
/// ($TMP/wpf-mcp.log, override with WPF_MCP_LOG). Never throws into a tool call.
public sealed class ToolLog
{
    private readonly bool _enabled;
    // Tool calls run concurrently and File.AppendAllText doesn't share the file with another
    // writer, so unserialized appends collide and the entry is lost. Covers this process only.
    private readonly Lock _gate = new();
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
            var entry = $"[{DateTime.UtcNow:yyyy-MM-dd'T'HH:mm:ss.fff'Z'}] {tool} ({timer.ElapsedMilliseconds}ms)\n  IN:  {JsonSerializer.Serialize(input)}\n  OUT: {preview}\n\n";
            lock (_gate) File.AppendAllText(Path, entry);
        }
        catch
        {
        }
    }
}
